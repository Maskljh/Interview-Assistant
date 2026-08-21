export type DetailSource = 'list' | 'questions' | 'trends';

const SOURCE_TO_DETAIL: Record<string, DetailSource> = {
  questions: 'questions',
  trends: 'trends',
};

export function detailSourceFrom(from: string | null): DetailSource {
  return from ? SOURCE_TO_DETAIL[from] ?? 'list' : 'list';
}

export function isFromQuestions(from: string | null): boolean {
  return detailSourceFrom(from) === 'questions';
}

export function isFromTrends(from: string | null): boolean {
  return detailSourceFrom(from) === 'trends';
}
