export interface GradeInput {
  pixelDiffPct: number
  cardinalityPct: number
  asset404Count: number
  totalAssets: number
  aiVisionScore: number
}

export interface GradeResult {
  letter: 'A' | 'B' | 'C' | 'D' | 'F'
  score: number
  perCheck: {
    pixel: number
    cardinality: number
    reachability: number
    aiVision: number
  }
}

export function computeGrade(input: GradeInput): GradeResult {
  const pixelScore = Math.max(0, 100 - input.pixelDiffPct * 2)
  const cardinalityScore = Math.min(100, input.cardinalityPct)
  const reachabilityScore = input.totalAssets === 0 ? 100 : Math.max(0, 100 - (input.asset404Count / input.totalAssets) * 100)
  const aiVisionScore = input.aiVisionScore

  const composite = pixelScore * 0.4 + cardinalityScore * 0.3 + reachabilityScore * 0.2 + aiVisionScore * 0.1
  const score = Math.round(composite)

  const letter: GradeResult['letter'] =
    score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F'

  return {
    letter,
    score,
    perCheck: {
      pixel: Math.round(pixelScore),
      cardinality: Math.round(cardinalityScore),
      reachability: Math.round(reachabilityScore),
      aiVision: Math.round(aiVisionScore),
    },
  }
}
