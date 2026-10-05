// Types for docket-api.cjs, the bundle of ../../src/api.ts that
// `pnpm run bundle` writes. Results are plain JSON; the panel reads them loosely.
export type ActionName =
  | 'start' | 'pause' | 'resume' | 'view'
  | 'accept' | 'decide' | 'unqueue' | 'reopen' | 'unstale' | 'endDiscussion'
  | 'replyApprove' | 'replySkip' | 'replyEdit'
export type PlanKind = 'ingest' | 'research' | 'apply' | 'reply' | 'discuss' | 'quickFix'
export interface ApiOptions {
  now?: () => string
  prLookup?: boolean
}
export declare function worktrees(path: string): unknown
export declare function snapshot(path: string, options?: ApiOptions): unknown
export declare function finding(path: string, id: string, options?: ApiOptions): unknown
export declare function action(path: string, name: ActionName, args?: Record<string, unknown>, options?: ApiOptions): unknown
export declare function plan(path: string, kind: PlanKind, args?: Record<string, unknown>, options?: ApiOptions): unknown
