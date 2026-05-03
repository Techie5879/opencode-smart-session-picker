import type { RankedCandidate, SearchDiagnostic } from "./types"

function normalize(rows: RankedCandidate[], key: "keywordScore" | "vectorScore") {
  const values = rows.map((row) => row[key] ?? 0)
  const min = Math.min(...values)
  const max = Math.max(...values)
  return new Map(rows.map((row) => [row.sessionID, max === min ? (values.length ? 1 : 0) : ((row[key] ?? 0) - min) / (max - min)]))
}

export function blendHybridScores(input: {
  keyword: RankedCandidate[]
  vector: RankedCandidate[]
  alpha: number
  vectorAvailable: boolean
}) {
  const diagnostics: SearchDiagnostic[] = []
  const alpha = Math.min(1, Math.max(0, input.alpha))
  const effectiveAlpha = input.vectorAvailable ? alpha : 0
  if (!input.vectorAvailable && alpha > 0) {
    diagnostics.push({
      kind: "vector-disabled",
      message: "Vector search is unavailable; using keyword ranking for this query.",
    })
  }

  const rows = new Map<string, RankedCandidate>()
  for (const row of input.keyword) rows.set(row.sessionID, { ...row, vectorScore: 0 })
  for (const row of input.vector) {
    const current = rows.get(row.sessionID)
    rows.set(row.sessionID, {
      ...current,
      ...row,
      keywordScore: current?.keywordScore ?? 0,
      snippet: current?.snippet ?? row.snippet,
    })
  }

  const values = [...rows.values()]
  const keyword = normalize(values, "keywordScore")
  const vector = normalize(values, "vectorScore")
  const ranked = values
    .map((row) => {
      const keywordScore = keyword.get(row.sessionID) ?? 0
      const vectorScore = vector.get(row.sessionID) ?? 0
      return {
        ...row,
        keywordScore,
        vectorScore,
        score: (1 - effectiveAlpha) * keywordScore + effectiveAlpha * vectorScore,
      }
    })
    .sort((a, b) => b.score - a.score)

  return { ranked, diagnostics }
}
