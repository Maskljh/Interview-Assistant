export type DetailSource = 'list' | 'questions';

export function detailSourceFrom(from: string | null): DetailSource {
  return from === 'questions' ? 'questions' : 'list';
}

export function isFromQuestions(from: string | null): boolean {
  return from === 'questions';
}
