export interface PageParams {
  page: number;
  limit: number;
}

export function parsePageParams(query: Record<string, any>): PageParams {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
  return { page, limit };
}

export function buildPaginatedResponse<T>(
  items: T[],
  totalCount: number,
  page: number,
  limit: number
) {
  const totalPages = Math.max(1, Math.ceil(totalCount / limit));
  return {
    items,
    data: items,
    page,
    limit,
    total: totalCount,
    totalPages,
    hasMore: page < totalPages,
    nextPage: page < totalPages ? page + 1 : null,
  };
}
