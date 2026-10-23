import { z } from 'zod';

export const idSchema = z.coerce.number().int().positive();
export const idParams = z.object({ id: idSchema });

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export function toPage(data, total, { page, limit }) {
  return { data, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

export const offsetOf = ({ page, limit }) => (page - 1) * limit;

/** Empty strings from forms become undefined so optional fields behave. */
export const optionalText = (max = 500) =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().trim().max(max).optional(),
  );

export const httpUrl = z
  .string()
  .trim()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), 'Must be an http(s) URL');

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email());
