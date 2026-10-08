export class ContractError extends Error {
  constructor(code, issues = []) {
    super(code);
    this.code = code;
    this.issues = issues;
  }
}
