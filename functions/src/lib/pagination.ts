export interface PaginationParams {
  page: number;
  limit: number;
  offset: number;
}

export function getPagination(
  page?: string | number,
  limit?: string | number
): PaginationParams {
  const parsedPage = Math.max(
    1,
    Number(page) || 1
  );

  const parsedLimit = Math.min(
    100,
    Math.max(1, Number(limit) || 20)
  );

  return {
    page: parsedPage,
    limit: parsedLimit,
    offset: (parsedPage - 1) * parsedLimit,
  };
}
