import * as core from '@actions/core'
import * as github from '@actions/github'
import {Octokit} from '@octokit/core'
import * as WebHooks from '@octokit/webhooks'
import ignore from 'ignore'

/** CODEOWNERS file contents */
type CodeOwners = {path: string; owners: string[]}[]

/** Per file review state */
type ReviewState = {path: string; nonApprovers: string[]; approvers: string[]}

/** Review state indicating approval */
const APPROVED = 'APPROVED'

/** Header for comment so it can be found again */
const COMMENT_HEADER = '<!-- codeowners comment header -->'

export default async function run(): Promise<void> {
  const codeowners_path = core.getInput('codeowners_path')
  if (codeowners_path === undefined) {
    core.error('"codeowners_path" is not set, exiting')
    return
  }

  const token = core.getInput('token')
  if (token === undefined) {
    core.error('"token" is not set in workflow file, exiting')
    return
  }

  const octokit = github.getOctokit(token)
  const context = github.context

  let payload

  switch (context.eventName) {
    case 'pull_request':
      payload = context.payload as WebHooks.EventPayloads.WebhookPayloadPullRequest
      break
    case 'pull_request_review':
      payload = context.payload as WebHooks.EventPayloads.WebhookPayloadPullRequestReview
      break
    default:
      core.setFailed(`Unexpected event: ${context.eventName}, skipping`)
      return
  }

  const pull_request = payload.pull_request

  const prAuthor = pull_request.user.login
  core.info(`Author: ${prAuthor}`)
  if (prAuthor !== 'nikclayton-dfinity') {
    core.info(`PR author ${prAuthor}, skipping`)
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
    pull_number: pull_request.number
  })

  core.info(`Files: ${files.map(file => file.filename).join(', ')}`)

  // Get all the reviewers who have approved this PR
  const approvingReviewers = await octokit.paginate(
    octokit.pulls.listReviews,
    {...context.repo, pull_number: pull_request.number},
    response =>
      response.data
        .filter(review => review.state === APPROVED)
        .filter(review => review.user !== undefined && review.user !== null)
        .map(review => review.user!.login)
  )

  core.info(`Approving Reviewers: ${approvingReviewers}`)

  /** State of the review */
  const reviewStates: ReviewState[] = []

  const teamMap = new Map()

  // Determine the owners for each file
  for (const file of files) {
    const filename = file.filename
    const fileOwners = getFileOwners(codeOwners, filename)
    const expandedFileOwners: string[] = []

    // Expand teams
    for (const owner of fileOwners) {
      if (!owner.includes('/')) {
        core.info(`${owner} is not a team, using as is`)
        expandedFileOwners.push(owner)
        continue
      }

      core.info(`${owner} is a team, expanding`)

      let members = teamMap.get(owner)
      if (members === undefined) {
        const team_slug = owner.split('/', 2)[1]
        core.info(`Getting members of ${team_slug}`)
        members = await octokit.paginate(octokit.teams.listMembersInOrg, {
          org: context.repo.owner,
          team_slug
        })
        teamMap.set(owner, members)
      }

      for (const member of members) {
        expandedFileOwners.push(member.login)
      }
    }

    // Has this file been approved by one of its owners?
    const approvers = expandedFileOwners.filter(owner =>
      approvingReviewers.includes(owner)
    )
    const nonApprovers = expandedFileOwners.filter(
      owner => !approvingReviewers.includes(owner)
    )

    reviewStates.push({
      path: filename,
      nonApprovers,
      approvers
    })
  }

  const commentContent = createCommentContent(reviewStates)

  core.info('Comment text')
  core.info(commentContent)

  // Find all comments
  const comments = await octokit.paginate(octokit.issues.listComments, {
    ...context.repo,
    issue_number: pull_request.number
  })

  // Find the first one that includes our header
  const previousComment = comments.find(
    comment => comment.body && comment.body.includes(COMMENT_HEADER)
  )

  // Update or create as necessary
  if (previousComment) {
    core.info('Found existing comment, updating')
    await octokit.issues.updateComment({
      ...context.repo,
      comment_id: previousComment.id,
      body: commentContent
    })
  } else {
    core.info('Did not find existing comment, creating new comment')
    await octokit.issues.createComment({
      ...context.repo,
      issue_number: pull_request.number,
      body: commentContent
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
function createCommentContent(reviewStates: ReviewState[]): string {
  const header = `${COMMENT_HEADER}\n**Review status**\n\n`

  const needApproval = []

  const totalFiles = reviewStates.length

  // No files in the PR? Indicate that and return
  if (totalFiles === 0) {
    return `${header} There are no files in the PR yet.`
  }

  // First, list the files that still need approval
  let filesProcessed = 0

  for (const entry of reviewStates) {
    if (entry.approvers.length === 0 && entry.nonApprovers.length > 0) {
      const nonApprovers = entry.nonApprovers.join(', ')
      needApproval.push(`&cross; \`${entry.path}\`: ${nonApprovers}`)
      filesProcessed++
    }
  }

  // If all files need to be approved then return early
  if (filesProcessed === totalFiles) {
    return `${header}${needApproval.join('\\\n')}`
  }

  // If there were no unapproved files then return early
  if (filesProcessed === 0) {
    return `${header}All files in the PR are approved.`
  }

  // Generate a <details> block for files that are approved or don't
  // need approval
  const approved = []
  for (const entry of reviewStates) {
    if (entry.approvers.length === 0 && entry.nonApprovers.length === 0) {
      approved.push(`&check; \`${entry.path}\`: No approval required`)
    } else if (entry.approvers.length > 0 || entry.nonApprovers.length === 0) {
      const approvers = entry.approvers.map(user => `**${user}**`)
      const allUsers = [...approvers, ...entry.nonApprovers].join(', ')
      approved.push(`&check; \`${entry.path}\`: ${allUsers}`)
    }
  }

  const body = `${header}${needApproval.join('\\\n')}
  
  <details>
  <summary>Approved files</summary>
  
  ${approved.join('\\\n')}
  
  </details>
  `

  return body
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
): string[] {
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
