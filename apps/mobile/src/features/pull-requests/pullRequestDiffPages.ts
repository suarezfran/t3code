import type { ChangeRequestTerminology } from "@t3tools/client-runtime/source-control-clients";
import type { PullRequestDiffResult } from "@t3tools/contracts";
import { buildReviewParsedDiff, type ReviewParsedDiff } from "../review/reviewModel";

export interface PullRequestDiffPage {
  readonly cursor: string | null;
  readonly result: PullRequestDiffResult;
}

interface CachedPullRequestDiffPages {
  readonly pages: readonly PullRequestDiffPage[];
  readonly cache: WeakMap<PullRequestDiffResult, ReviewParsedDiff>;
  readonly parsed: ReviewParsedDiff;
}

// Keep only the latest combination per scoped first page; query results own its lifetime.
const parsedSnapshots = new WeakMap<
  PullRequestDiffResult,
  Map<string, CachedPullRequestDiffPages>
>();

/**
 * Returns the same combination while the pages are unchanged, so a new route reading the same
 * query result reuses it. `cache` parses pages once across readers that share a scope.
 */
export function getCachedPullRequestDiffPages(
  pages: readonly PullRequestDiffPage[],
  scope: string,
  terminology: ChangeRequestTerminology,
  cache?: WeakMap<PullRequestDiffResult, ReviewParsedDiff>,
): ReviewParsedDiff {
  const first = pages[0];
  if (!first) return { kind: "empty" };
  const key = JSON.stringify([scope, terminology.singular, first.cursor]);
  let snapshots = parsedSnapshots.get(first.result);
  if (!snapshots) {
    snapshots = new Map();
    parsedSnapshots.set(first.result, snapshots);
  }
  const previous = snapshots.get(key);
  if (
    previous?.pages.length === pages.length &&
    pages.every((page, index) => {
      const cached = previous.pages[index];
      return cached?.cursor === page.cursor && cached.result === page.result;
    })
  )
    return previous.parsed;
  const pageCache =
    cache ?? previous?.cache ?? new WeakMap<PullRequestDiffResult, ReviewParsedDiff>();
  const parsed = combinePullRequestDiffPages(pages, pageCache, scope, terminology);
  snapshots.set(key, { pages, cache: pageCache, parsed });
  return parsed;
}

/**
 * What a walk saw last time. Some hosts' cursors are bare page numbers, so a later page cached
 * before an earlier page changed still matches its cursor; such a page is held until it reloads.
 */
export interface PullRequestDiffPagesMemory {
  readonly results: Map<string | null, PullRequestDiffResult>;
  readonly stale: WeakSet<PullRequestDiffResult>;
  readonly reloading: WeakSet<PullRequestDiffResult>;
}

export function createPullRequestDiffPagesMemory(): PullRequestDiffPagesMemory {
  return { results: new Map(), stale: new WeakSet(), reloading: new WeakSet() };
}

function samePullRequestDiffPage(a: PullRequestDiffResult, b: PullRequestDiffResult): boolean {
  return (
    a === b ||
    (a.patch === b.patch &&
      a.truncated === b.truncated &&
      a.nextCursor === b.nextCursor &&
      JSON.stringify(a.omittedFileStats ?? []) === JSON.stringify(b.omittedFileStats ?? []))
  );
}

/**
 * Follows next cursors until `count` pages, every wanted path, and (given `shown`) one shown file
 * have loaded. `frontier` is the cursor it stopped on: the last page read, or one loading, failed,
 * or held as stale. `reload` names a page that just went stale, for the caller to refetch.
 */
export function walkPullRequestDiffPages(
  read: (cursor: string | null) => PullRequestDiffResult | null,
  count: number,
  wanted: readonly string[],
  paths: (page: PullRequestDiffPage) => readonly string[],
  shown?: (path: string) => boolean,
  memory?: PullRequestDiffPagesMemory,
): {
  readonly pages: readonly PullRequestDiffPage[];
  readonly frontier: string | null;
  readonly reload?: string | null | undefined;
} {
  const pages: PullRequestDiffPage[] = [];
  const missing = new Set(wanted);
  const seen = new Set<string | null>();
  let showing = !shown;
  let cursor: string | null = null;
  for (;;) {
    seen.add(cursor);
    const result = read(cursor);
    if (result === null) return { pages, frontier: cursor };
    if (memory) {
      if (memory.stale.has(result)) {
        if (memory.reloading.has(result)) return { pages, frontier: cursor };
        memory.reloading.add(result);
        return { pages, frontier: cursor, reload: cursor };
      }
      const previous = memory.results.get(cursor);
      memory.results.set(cursor, result);
      // Every page remembered past this one may come from the old answer, whichever reader
      // walked that far.
      if (previous !== undefined && !samePullRequestDiffPage(previous, result))
        for (const [other, answer] of memory.results)
          if (!seen.has(other)) memory.stale.add(answer);
    }
    const page = { cursor, result };
    pages.push(page);
    for (const path of paths(page)) {
      missing.delete(path);
      if (shown?.(path)) showing = true;
    }
    const next = result.nextCursor;
    if (next === null || seen.has(next) || (pages.length >= count && missing.size === 0 && showing))
      return { pages, frontier: cursor };
    cursor = next;
  }
}

export interface PullRequestDiffRequest {
  readonly key: string;
  readonly count: number;
  readonly wanted: readonly string[];
}

/**
 * Wanted paths only accumulate for a target: dropping one would let the walk stop at an earlier
 * file and shrink the diff the screen already shows. A new target starts over.
 */
export function requestPullRequestDiffPaths(
  request: PullRequestDiffRequest,
  key: string,
  wanted: readonly string[],
): PullRequestDiffRequest {
  if (request.key !== key) return { key, count: 1, wanted };
  const added = wanted.filter((path) => !request.wanted.includes(path));
  return added.length === 0 ? request : { ...request, wanted: [...request.wanted, ...added] };
}

export function parsePullRequestDiffPage(
  page: PullRequestDiffPage,
  cache: WeakMap<PullRequestDiffResult, ReviewParsedDiff>,
  scope: string,
): ReviewParsedDiff {
  const cached = cache.get(page.result);
  if (cached) return cached;
  let value = buildReviewParsedDiff(page.result.patch, `${scope}:${page.cursor ?? "first"}`);
  if (value.kind === "files" && page.result.omittedFileStats?.length) {
    const omittedFileStats = new Map(page.result.omittedFileStats.map((stat) => [stat.path, stat]));
    const files = value.files.map((file) => {
      const stat = omittedFileStats.get(file.path);
      return stat ? { ...file, additions: stat.additions, deletions: stat.deletions } : file;
    });
    value = {
      ...value,
      files,
      additions: files.reduce((total, file) => total + file.additions, 0),
      deletions: files.reduce((total, file) => total + file.deletions, 0),
    };
  }
  cache.set(page.result, value);
  return value;
}

export function combinePullRequestDiffPages(
  pages: readonly PullRequestDiffPage[],
  cache: WeakMap<PullRequestDiffResult, ReviewParsedDiff>,
  scope: string,
  terminology: ChangeRequestTerminology,
): ReviewParsedDiff {
  const parsed = pages.map((page) => parsePullRequestDiffPage(page, cache, scope));
  const files = parsed.flatMap((page) => (page.kind === "files" ? page.files : []));
  if (files.length === 0) return parsed[0] ?? { kind: "empty" };
  return {
    kind: "files",
    files,
    fileCount: files.length,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    notice:
      pages.some((page) => page.result.truncated) ||
      parsed.some((page) => page.kind === "raw" || (page.kind === "files" && page.notice !== null))
        ? `Some file contents are unavailable. Open the ${terminology.singular} on its provider to see the full changes.`
        : null,
  };
}
