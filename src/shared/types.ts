// Shared types used across client and server

export interface User {
  id: number;
  email: string;
  password: string;
  name: string;
  role: "admin" | "user";
  created_at: string;
}

export interface Post {
  id: number;
  title: string;
  content: string;
  author_id: number;
  status: "draft" | "published";
  views: number;
  created_at: string;
  updated_at: string;
}

export interface Comment {
  id: number;
  post_id: number;
  user_id: number;
  body: string;
  created_at: string;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  total: number;
  page: number;
  limit: number;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface CreatePostRequest {
  title: string;
  content: string;
  status?: "draft" | "published";
}

export interface CreateCommentRequest {
  body: string;
}
