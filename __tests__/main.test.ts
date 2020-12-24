import {FileUnderReview, FileApprovalState} from '../src/file_under_review'
import {
  getFileOwners,
  parseCodeOwnersContent,
  createCommentBody
} from '../src/main'

describe('parseCodeOwnersContent', () => {
  const tests = [
    {
      name: 'single line',
      content: '/foo @nikclayton',
      want: [{path: '/foo', owners: ['@nikclayton']}]
    },
    {
      name: 'comment',
      content: `# This is a comment
/foo @nikclayton`,
      want: [{path: '/foo', owners: ['@nikclayton']}]
    },
    {
      name: 'multiple owners',
      content: '/foo @bar @baz',
      want: [{path: '/foo', owners: ['@bar', '@baz']}]
    }
  ]

  for (const t of tests) {
    test(t.name, () => {
      const got = parseCodeOwnersContent(t.content)
      expect(got).toEqual(t.want)
    })
  }
})

describe('getFileOwners', () => {
  const tests = [
    {
      name: 'single owner',
      content: '/foo @nikclayton',
      filename: 'foo',
      want: ['nikclayton']
    },
    {
      name: 'multiple owners',
      content: '/foo @bar @baz',
      filename: 'foo',
      want: ['bar', 'baz']
    },
    {
      name: 'last entry wins',
      content: `/foo @bar @baz
/foo @fred`,
      filename: 'foo',
      want: ['fred']
    },
    {
      name: 'file in any subdirectory matches',
      content: 'foo/ @bar',
      filename: 'foo/bar/baz',
      want: ['bar']
    },
    {
      name: 'only immediate children are tested (1)',
      content: 'foo/*.txt @bar',
      filename: 'foo/test.txt',
      want: ['bar']
    },
    {
      name: 'only immediate children are tested (2)',
      content: 'foo/*.txt @bar',
      filename: 'foo/bar/test.txt',
      want: []
    },
    {
      name: 'file with no owners',
      content: '/foo @bar',
      filename: 'not-in-codeowners',
      want: []
    },
    {
      name: '@ghost implies no owners',
      content: '/foo @ghost',
      filename: 'foo',
      want: []
    }
  ]

  for (const t of tests) {
    test(t.name, () => {
      const codeOwners = parseCodeOwnersContent(t.content)
      const owners = getFileOwners(codeOwners, t.filename)
      expect(owners).toEqual(t.want)
    })
  }
})

describe('File class', () => {
  const tests = [
    {
      name: 'Single approved file',
      approvers: ['foo'],
      reviewers: ['foo'],
      files: [
        {
          path: 'path/to/file',
          owners: ['foo'],
          state: FileApprovalState.Approved
        }
      ]
    },
    {
      name: 'Two approved files',
      approvers: ['foo'],
      reviewers: ['foo'],
      files: [
        {
          path: 'path/to/file',
          owners: ['foo'],
          state: FileApprovalState.Approved
        },
        {
          path: 'other/path/to/file',
          owners: ['foo'],
          state: FileApprovalState.Approved
        }
      ]
    },
    {
      name: 'One approved file, one with no owner',
      approvers: ['foo'],
      reviewers: ['foo'],
      files: [
        {
          path: 'path/to/file',
          owners: ['foo'],
          state: FileApprovalState.Approved
        },
        {
          path: 'other/path/to/file',
          owners: [],
          state: FileApprovalState.NoOwners
        }
      ]
    },
    {
      name: 'Reviewers cannot approve',
      approvers: ['bar'],
      reviewers: ['bar'],
      files: [
        {
          path: 'path/to/file',
          owners: ['foo'],
          state: FileApprovalState.Unapprovable
        }
      ]
    },
    {
      name: 'Multiple owners, one approval',
      approvers: ['foo'],
      reviewers: ['foo'],
      files: [
        {
          path: 'path/to/file',
          owners: ['bar', 'foo'],
          state: FileApprovalState.Approved
        }
      ]
    },
    {
      name: 'Single unapproved file',
      approvers: [],
      reviewers: ['foo'],
      files: [
        {
          path: 'path/to/file',
          owners: ['foo'],
          state: FileApprovalState.Pending
        }
      ]
    },
    {
      name: 'One approved file, one waiting for approval',
      approvers: ['foo'],
      reviewers: ['foo', 'bar'],
      files: [
        {
          path: 'path/to/file',
          owners: ['foo', 'bar'],
          state: FileApprovalState.Approved
        },
        {
          path: 'other/path/to/file',
          owners: ['bar'],
          state: FileApprovalState.Pending
        }
      ]
    }
  ]

  for (const t of tests) {
    test(t.name, () => {
      const files = t.files.map(
        file =>
          new FileUnderReview(
            file.path,
            new Set(t.approvers),
            new Set(file.owners),
            new Set(t.reviewers)
          )
      )

      for (const index in files) {
        expect(files[index].approval).toEqual(t.files[index].state)
      }

      expect(createCommentBody(files)).toMatchSnapshot()
    })
  }
})
