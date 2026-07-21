import type { Page } from './tasks.js';

export interface Memory {
  slug: string;
  description: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface UpsertMemoryInput {
  description: string;
  content: string;
  expectedUpdatedAt?: string;
  expectedRevision?: number;
}

export interface MemoryFilters {
  text?: string;
  cursor?: string;
  limit?: number;
}

export type MemoryPage = Page<Memory>;
