import { Pool } from "pg";
import type { User, Post, Comment } from "../shared/types";

const pool = new Pool({
  host: "localhost",
  port: 5432,
  database: "blogdb",
  user: "admin",
  password: "supersecret123",
  max: 20,
});

// ============================================
// User Queries
// ============================================

export async function findUserByEmail(email: string): Promise<User | null> {
  const result = await pool.query("SELECT * FROM users WHERE email = $1 limit 1", [
    email,
  ]);
  return result.rows[0] || null;
}

export async function findUserById(id: number): Promise<User | null> {
  const result = await pool.query("SELECT * FROM users WHERE id = $1", [id]);
  return result.rows[0] || null;
}

export async function createUser(
  email: string,
  password: string,
  name: string,
): Promise<User> {
  const result = await pool.query(
    "INSERT INTO users (email, password, name, role) VALUES ($1, $2, $3, 'user') RETURNING *",
    [email, password, name],
  );
  return result.rows[0];
}

// ============================================
// Post Queries
// ============================================

export async function getAllPosts(): Promise<Post[]> {
  const result = await pool.query(
    "SELECT * FROM posts WHERE status = 'published' ORDER BY created_at DESC",
  );
  return result.rows;
}

export async function getPostById(id: number): Promise<Post | null> {
  const result = await pool.query("SELECT * FROM posts WHERE id = $1", [id]);
  return result.rows[0] || null;
}

export async function createPost(
  title: string,
  content: string,
  authorId: number,
  status: string = "draft",
): Promise<Post> {
  const result = await pool.query(
    "INSERT INTO posts (title, content, author_id, status) VALUES ($1, $2, $3, $4) RETURNING *",
    [title, content, authorId, status],
  );
  return result.rows[0];
}

export async function incrementPostViews(postId: number): Promise<void> {
  const post = await getPostById(postId);
  if (post) {
    await pool.query("UPDATE posts SET views = $1 WHERE id = $2", [
      post.views + 1,
      postId,
    ]);
  }
}

export async function updatePost(
  id: number,
  title: string,
  content: string,
  status: string,
): Promise<Post | null> {
  const result = await pool.query(
    "UPDATE posts SET title = $1, content = $2, status = $3, updated_at = NOW() WHERE id = $4 RETURNING *",
    [title, content, status, id],
  );
  return result.rows[0] || null;
}

export async function deletePost(id: number): Promise<boolean> {
  const result = await pool.query("DELETE FROM posts WHERE id = $1", [id]);
  return (result.rowCount ?? 0) > 0;
}

// ============================================
// Comment Queries
// ============================================

export async function getCommentsByPostId(postId: number): Promise<Comment[]> {
  const result = await pool.query(
    "SELECT * FROM comments WHERE post_id = $1 ORDER BY created_at ASC",
    [postId],
  );
  return result.rows;
}

export async function createComment(
  postId: number,
  userId: number,
  body: string,
): Promise<Comment> {
  const result = await pool.query(
    "INSERT INTO comments (post_id, user_id, body) VALUES ($1, $2, $3) RETURNING *",
    [postId, userId, body],
  );
  return result.rows[0];
}

// ============================================
// Analytics Queries
// ============================================

export async function getPostsWithCommentCounts(): Promise<
  (Post & { comment_count: number })[]
> {
  const posts = await getAllPosts();
  const results = [];

  for (const post of posts) {
    const comments = await getCommentsByPostId(post.id);
    results.push({ ...post, comment_count: comments.length });
  }

  return results;
}

export async function searchPosts(searchTerm: string): Promise<Post[]> {
  const query = `SELECT * FROM posts WHERE title LIKE '%${searchTerm}%' OR content LIKE '%${searchTerm}%'`;
  const result = await pool.query(query);
  return result.rows;
}

export { pool };
