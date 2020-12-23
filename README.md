<p align="center">
  <img alt="typescript-action status" src="https://github.com/dfinity-lab/codeowners/workflows/build-test/badge.svg">
</p>

# Comment on PRs with missing / obtained approvals

GitHub's UI doesn't always make it clear which approvals remain for a PR.
This action adds a comment to a PR clearly indicating who is needed to approve the PR based on the files on the PR.

As approvals come in the comment is updated to reflect the current approval
status and which files still need approval.

# Usage

## Optional: Create an access token for the action

You must do this if your `CODEOWNERS` file uses teams, otherwise the action
will not be able to expand the team to its list of members.

Follow the instructions at [Create a personal access token](https://docs.github.com/en/free-pro-team@latest/github/authenticating-to-github/creating-a-personal-access-token) to create a token that the action can use.

This token must have `repo` and `read:org` scopes. The [GITHUB_TOKEN](https://docs.github.com/en/free-pro-team@latest/actions/reference/authentication-in-a-workflow) secret that GitHub normally provides for actions
is insufficient, as it lacks the `read:org` scope necessary to expand a team
to its list of members.

Add the token as an [encrypted secret](https://docs.github.com/en/free-pro-team@latest/actions/reference/encrypted-secrets) to the repository
in which you will be running the action. I use the name
`CODEOWNERS_ACTION_TOKEN` for the secret.

## Enable for a repository

Create the directory `.github/workflows` in the repository if necessary,
and then create the file `codeowners-report.yml` in that directory with the
following contents.

```
name: Codeowners report

on:
  pull_request:
    types: [opened, reopened, synchronize]
  pull_request_review:
    types: [submitted]

jobs:
  codeowners:
    runs-on: ubuntu-latest
    steps:
      - uses: dfinity-lab/codeowners@main
        with:
          codeowners_path: CODEOWNERS
          token: ${{ secrets.CODEOWNERS_ACTION_TOKEN }}
```

The options you may want to configure are:

- `uses`: This will always use the latest version of the code
  (`dfinity-lab/codeowners@main`). Adjust this if you want to use a specific
  release or commit.

- `codeowners_path`: Where the `CODEOWNERS` file is in the repository.
  Per [About code owners](https://docs.github.com/en/free-pro-team@latest/github/creating-cloning-and-archiving-repositories/about-code-owners)
  valid values are `CODEOWNERS`, `docs/CODEOWNERS`, or `.github/CODEOWNERS`.

- `token`: The name of the secret you created in the previous step. If you did
  not need to create a personal access token you can use `secrets.GITHUB_TOKEN`
  as the `token` value.
