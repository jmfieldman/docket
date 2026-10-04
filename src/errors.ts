/** An error the CLI reports to the user with a stable code and exit status. */
export class DocketError extends Error {
  readonly code: string
  readonly exitCode: number

  constructor(code: string, message: string, exitCode = 1) {
    super(message)
    this.name = 'DocketError'
    this.code = code
    this.exitCode = exitCode
  }
}
