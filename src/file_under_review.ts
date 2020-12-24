export enum FileApprovalState {
  /** File does not need approval as it has no owners */
  NoOwners,
  /** File has been approved by at least one reviewer who can approve it */
  Approved,
  /** File has not yet been approved, reviewer set can approve */
  Pending,
  /** File can not be approved by the current reviewer set */
  Unapprovable
}

export class FileUnderReview {
  readonly path: string
  readonly approval: FileApprovalState
  private approvers: Set<string>
  private owners: Set<string>

  constructor(
    path: string,
    approvers: Set<string>,
    owners: Set<string>,
    reviewers: Set<string>
  ) {
    this.path = path
    this.approvers = approvers
    this.owners = owners

    // No owners?
    if (this.owners.size === 0) {
      this.approval = FileApprovalState.NoOwners
      return
    }

    // None of the reviewers can approve
    const reviewerIntersection = new Set(
      [...reviewers].filter(user => owners.has(user))
    )
    if (reviewerIntersection.size === 0) {
      this.approval = FileApprovalState.Unapprovable
      return
    }

    // Approved by an owner?
    const approverIntersection = new Set(
      [...approvers].filter(user => owners.has(user))
    )
    if (approverIntersection.size > 0) {
      this.approval = FileApprovalState.Approved
      return
    }

    // Default is "Pending"
    this.approval = FileApprovalState.Pending
  }

  /** @returns a GFM string containing the approval comment for this file */
  get comment(): string {
    switch (this.approval) {
      case FileApprovalState.NoOwners:
        return `&check; \`${this.path}\`: File has no owners, no approval required`
      case FileApprovalState.Approved:
        return `&check; \`${this.path}\`: ${this.ownersString()}`
      case FileApprovalState.Pending:
        return `&cross; \`${this.path}\`: ${this.ownersString()}`
      case FileApprovalState.Unapprovable:
        return `&cross; \`${this.path}\`: ${this.ownersString()}`
    }
  }

  /**
   * @returns A GFM string containing a ', ' list of the file's owners. Owners
   * that have approved the file are marked in bold ('**')
   */
  private ownersString(): string {
    const owners = []
    for (const owner of this.owners.values()) {
      if (this.approvers.has(owner)) {
        owners.push(`**${owner}**`)
      } else {
        owners.push(owner)
      }
    }
    return owners.join(', ')
  }
}
