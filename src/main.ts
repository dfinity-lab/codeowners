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
  const token = core.getInput('token')
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
  }

  const codeOwners = await getCodeOwnersMap(
    context.repo,
    octokit,
    '.github/CODEOWNERS'
  )

  // Get the files in this PR
  const files = await octokit.paginate(octokit.pulls.listFiles, {
    ...context.repo,
    pull_number: pull_request.number
  })

  core.info(`Files: ${files.join(',')}`)

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
        members = await octokit.paginate(octokit.teams.listMembersInOrg, {
          org: context.repo.owner,
          team_slug: owner
        })
        teamMap.set(owner, members)
        core.info(`expanded ${owner} -> ${members.join(', ')}`)
      }

      members.forEach((member: string) => expandedFileOwners.push(member))
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
    await octokit.issues.updateComment({
      ...context.repo,
      comment_id: previousComment.id,
      body: commentContent
    })
  } else {
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
 * Start with a heading, and then one line per file with either a check or
 * a cross indicating the state, and the filename. Approving reviewers are
 * show in bold, non-approving reviewers without bold.
 *
 * ---
 * **Review status**:
 *
 * &check; `path/to/file`: foo, **bar**, **baz**\
 * &check; `a/nother/file`: foo, **baz**\
 * &cross; `one/more/file`: foo\
 * ---
 *
 * @param reviewStates
 */
function createCommentContent(reviewStates: ReviewState[]): string {
  let comment = `${COMMENT_HEADER}**Review status**\n\n`

  for (const entry of reviewStates) {
    if (entry.approvers.length > 0 || entry.nonApprovers.length === 0) {
      const status = '&check;'
      const approvers = entry.approvers.map(user => `**${user}**`)
      const allUsers = [...approvers, ...entry.nonApprovers].join(', ')
      comment += `${status} \`${entry.path}\`: ${allUsers}\\\n`
    } else {
      const status = '&cross;'
      const nonApprovers = entry.nonApprovers.join(', ')
      comment += `${status} \`${entry.path}\`: ${nonApprovers}\\\n`
    }
  }

  return comment
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
