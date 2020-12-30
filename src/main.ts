import * as core from '@actions/core'
import * as github from '@actions/github'
import {Octokit} from '@octokit/core'
import * as WebHooks from '@octokit/webhooks'
import ignore from 'ignore'
import {FileApprovalState, FileUnderReview} from './file_under_review'

/** Name of something that can own a file. Might be user, might be a team */
type Owner = string

/** CODEOWNERS file contents */
type CodeOwners = {path: string; owners: Owner[]}[]

/** Review state indicating approval */
const APPROVED = 'APPROVED'

/** Header for comment so it can be found again */
const COMMENT_HEADER = '<!-- codeowners comment header -->'

export default async function run(): Promise<void> {
  const codeowners_path = core.getInput('codeowners_path', {required: true})
  const token = core.getInput('token', {required: true})
  const octokit = github.getOctokit(token)
  const context = github.context

  core.info(`eventName: ${context.eventName}`)

  let payload
  switch (context.eventName) {
    case 'pull_request':
      payload = context.payload as WebHooks.EventPayloads.WebhookPayloadPullRequest
      break
    case 'pull_request_review':
      payload = context.payload as WebHooks.EventPayloads.WebhookPayloadPullRequestReview
      break
    default:
      core.setFailed(`Unexpected event: ${context.eventName}, exiting`)
      return
  }

  const pull_request = payload.pull_request
  core.info(`pull_request: ${JSON.stringify(pull_request)}`)
  const pull_number = pull_request.number

  // TODO: Ignore draft PRs? .draft property is only present if this is a
  // WebhookPayloadPullRequest -- sort of makes sense, you wouldn't expect
  // to get a review unless the PR was out of draft.

  const prAuthor = pull_request.user.login
  core.info(`Author: ${prAuthor}`)

  const authorAllowList = ['nikclayton-dfinity', 'nomeata']
  if (!authorAllowList.includes(prAuthor)) {
    core.info(`PR author ${prAuthor} not in allow list, skipping`)
    return
  }

  const codeOwners = await getCodeOwnersMap(
    context.repo,
    octokit,
    codeowners_path
  )

  // Get the files in this PR
  const files = await octokit.paginate(octokit.pulls.listFiles, {
    ...context.repo,
    pull_number
  })

  core.info(`Files: ${files.map(file => file.filename).join(', ')}`)

  // Find all the PR reviewers. There are two groups:
  //
  // 1. The "requested" reviewers -- the ones that the PR author has explicitly
  // listed for a review (or have been added automatically). This information is
  // already present on the `pull_request` property.
  //
  // 2. Drive-bys -- other users who have seen the PR and left a review. This
  // has to be fetched separately.

  // requestedReviewers may contain teams. Since a reviewer can approve on
  // behalf of multiple teams, flatten this to a set of usernames
  const reviewers = new Set([
    ...pull_request.requested_reviewers.map(user => user.login)
  ])
  core.info(`Requested reviewers (users): ${JSON.stringify(reviewers)}`)
  for (const team of pull_request.requested_teams) {
    core.info(`Requested reviewer (team): ${team}`)
    for (const member of await getTeamMembers(
      context.repo,
      octokit,
      team.slug
    )) {
      core.info(`member: ${member}`)
      reviewers.add(member)
    }
  }

  core.info(`Final set of reviewers: ${JSON.stringify(reviewers)}`)

  // Get all the reviews of this PR
  const reviews = await octokit.paginate(octokit.pulls.listReviews, {
    ...context.repo,
    pull_number
  })

  // Add all the users who have left a review to the set of reviewers. Also,
  // track who has left an approving review.

  /** Users who left an approving review */
  const approvingReviewers: Set<string> = new Set()
  for (const review of reviews) {
    if (review.user === undefined || review.user === null) {
      continue
    }
    reviewers.add(review.user.login)
    if (review.state === APPROVED) {
      approvingReviewers.add(review.user.login)
    }
  }

  /** Files in this PR, their owners, review states */
  const filesUnderReview: FileUnderReview[] = []

  // Calculate approval state for each file
  for (const file of files) {
    // Expand any team names to users
    const fileOwners = getFileOwners(codeOwners, file.filename)
    const expandedFileOwners: Set<string> = new Set()
    for (const owner of fileOwners) {
      if (!owner.includes('/')) {
        expandedFileOwners.add(owner)
        continue
      }

      const team_slug = owner.split('/', 2)[1]
      for (const member of await getTeamMembers(
        context.repo,
        octokit,
        team_slug
      )) {
        expandedFileOwners.add(member)
      }
    }

    // Create the final file representation
    filesUnderReview.push(
      new FileUnderReview(
        file.filename,
        approvingReviewers,
        expandedFileOwners,
        reviewers
      )
    )
  }

  // Generate the comment body
  const commentBody = createCommentBody(filesUnderReview)

  core.info('Comment body')
  core.info(commentBody)

  // Find the first comment that includes the header. Fetch all the comments,
  // paginating, stopping as soon as we find a page with a comment that
  // contains the header (to reduce API call usage).
  const comments = await octokit.paginate(
    octokit.issues.listComments,
    {
      ...context.repo,
      issue_number: pull_number
    },
    (response, done) => {
      response.data.find(
        comment => comment.body && comment.body.includes(COMMENT_HEADER)
      ) &&
        done &&
        done()
      return response.data
    }
  )
  // Find the actual comment
  const previousComment = comments.find(
    comment => comment.body && comment.body.includes(COMMENT_HEADER)
  )

  // Update or create as necessary
  if (previousComment) {
    core.info('Found existing comment, updating')
    await octokit.issues.updateComment({
      ...context.repo,
      comment_id: previousComment.id,
      body: commentBody
    })
  } else {
    core.info('Did not find existing comment, creating new comment')
    await octokit.issues.createComment({
      ...context.repo,
      issue_number: pull_request.number,
      body: commentBody
    })
  }
}

/**
 * Create a GFM comment based on the reviewStates.
 *
 * Start with COMMENT_HEADER, so this comment can be found again in
 * subsequent runs.
 *
 * If any files need approval, list them, like
 *
 * ----
 * &cross; `one/more/file`: foo\
 * ----
 *
 * List all files that don't need approval in a <details> block so they are
 * hidden by default.
 *
 * @param reviewStates
 */
export function createCommentBody(files: FileUnderReview[]): string {
  const header = `${COMMENT_HEADER}\n**Review status**\n\n`

  if (files.length === 0) {
    return `${header}There are no files in the PR.`
  }

  // Files that can't be approved get their own section
  let unapprovableComment = ''
  const filesUnapprovable = files
    .filter(file => file.approval === FileApprovalState.Unapprovable)
    .map(file => file.comment)

  if (filesUnapprovable.length > 0) {
    unapprovableComment = `PR can not be approved, as these files can not be approved by the current reviewers:\n\n${filesUnapprovable.join(
      '\\\n'
    )}\n\n`
  }

  // Files that need approval get their own section
  let pendingComment = ''
  const filesPending = files
    .filter(file => file.approval === FileApprovalState.Pending)
    .map(file => file.comment)
  if (filesPending.length > 0) {
    pendingComment = `Waiting for approval\n\n${filesPending.join('\\\n')}\n\n`
  }

  // If everything is approved then skip generating the list as it's noise
  // at this point.
  if (filesUnapprovable.length === 0 && filesPending.length === 0) {
    return `${header}All files in the PR are approved.`
  }

  // Files that are approved are in a <details> block
  let approvedComment = ''
  const filesApproved = files
    .filter(
      file =>
        file.approval === FileApprovalState.NoOwners ||
        file.approval === FileApprovalState.Approved
    )
    .map(file => file.comment)
  if (filesApproved.length > 0) {
    approvedComment = `
<details>
  <summary>Approved files</summary>
    
${filesApproved.join('\\\n')}
    
</details>`
  }

  return `${header}${unapprovableComment}${pendingComment}${approvedComment}`
}

/**
 * Parse the CODEOWNERS file in to a map
 *
 * @param context
 */
async function getCodeOwnersMap(
  repo: {owner: string; repo: string},
  octokit: Octokit,
  file: string
): Promise<CodeOwners> {
  core.info(`Loading owners from ${file}`)
  const result = await octokit.repos.getContent({...repo, path: file})
  const content = Buffer.from(result.data.content, 'base64').toString()

  return parseCodeOwnersContent(content)
}

export function parseCodeOwnersContent(content: string): CodeOwners {
  return content
    .split('\n')
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const trimmed = line.trim()
      const [path, ...owners] = trimmed.split(/\s+/)
      return {path, owners}
    })
}

/**
 * An array of owners of the given file. Empty array if the file has no owners.
 *
 * @param codeowners
 * @param filename
 */
export function getFileOwners(
  codeowners: CodeOwners,
  filename: string
): Owner[] {
  // CODEOWNERS is last-one-wins. Treat it as though it was a .gitignore file,
  // process each entry in reverse, and check to see if the entry would ignore
  // `filename`. If it would then the entry is match.
  const match = codeowners
    .slice()
    .reverse()
    .find(entry => ignore().add(entry.path).ignores(filename))
  if (!match) return []
  // @ghost is special, and is used to disavow ownership, equivalent to the
  // file having no owners.
  if (match.owners[0] === '@ghost') return []
  return match.owners.map(user => user.replace('@', ''))
}

/** Map from team slug to members of the team */
const teamCache = new Map()

async function getTeamMembers(
  repo: {owner: string; repo: string},
  octokit: Octokit,
  team_slug: string
): Promise<string[]> {
  let members = teamCache.get(team_slug)
  if (members === undefined) {
    members = await octokit.paginate(octokit.teams.listMembersInOrg, {
      org: repo.owner,
      team_slug
    })
    teamCache.set(team_slug, members)
  }
  return Promise.resolve(members.map((member: {login: string}) => member.login))
}
