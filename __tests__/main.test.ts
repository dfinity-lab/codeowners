import {getFileOwners, parseCodeOwnersContent} from '../src/main'

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
