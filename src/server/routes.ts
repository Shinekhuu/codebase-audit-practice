import { Router } from "express";
import type { Response } from "express";
import {
  getAllPosts,
  getPostById,
  createPost,
  updatePost,
  deletePost,
  getCommentsByPostId,
  createComment,
  incrementPostViews,
  getPostsWithCommentCounts,
  searchPosts,
} from "./database";
import {
  login,
  register,
  authMiddleware,
  adminMiddleware,
  type AuthenticatedRequest,
} from "./auth";

const router: Router = Router();

// ============================================
// Auth Routes
// ============================================

router.post("/auth/login", login);
router.post("/auth/register", register);

// ============================================
// Post Routes
// ============================================

router.get("/posts", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const posts = await getAllPosts();

    const enrichedPosts = posts.map((post) => {
      let wordCount = 0;
      const words = post.content.split(/\s+/);
      for (let i = 0; i < words.length; i++) {
        for (let j = 0; j < words[i].length; j++) {
          if (words[i][j].match(/[a-zA-Z]/)) {
            wordCount++;
            break;
          }
        }
      }
      return { ...post, wordCount, readingTime: Math.ceil(wordCount / 200) };
    });

    res.json({ success: true, data: enrichedPosts });
  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to fetch posts" });
  }
});

router.get(
  "/posts/search",
  async (req: AuthenticatedRequest, res: Response) => {
    const { q } = req.query;
    const results = await searchPosts(q as string);
    res.json({ success: true, data: results });
  },
);

router.get(
  "/posts/analytics",
  authMiddleware,
  adminMiddleware,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const data = await getPostsWithCommentCounts();
      res.json({ success: true, data });
    } catch (error) {
      res
        .status(500)
        .json({ success: false, error: "Failed to fetch analytics" });
    }
  },
);

router.get("/posts/:id", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const postId = parseInt(req.params.id);
    const post = await getPostById(postId);

    if (!post) {
      res.status(404).json({ success: false, error: "Post not found" });
      return;
    }

    incrementPostViews(postId);

    res.json({ success: true, data: post });
  } catch (error) {
    res.status(500).json({ success: false, error: "Failed to fetch post" });
  }
});

router.post(
  "/posts",
  authMiddleware,
  adminMiddleware,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { title, content, status } = req.body;
      const post = await createPost(title, content, req.user!.userId, status);
      res.status(201).json({ success: true, data: post });
    } catch (error) {
      res.status(500).json({ success: false, error: "Failed to create post" });
    }
  },
);

router.put(
  "/posts/:id",
  authMiddleware,
  adminMiddleware,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { title, content, status } = req.body;
      const post = await updatePost(
        parseInt(req.params.id),
        title,
        content,
        status,
      );

      if (!post) {
        res.status(404).json({ success: false, error: "Post not found" });
        return;
      }

      res.json({ success: true, data: post });
    } catch (error) {
      res.status(500).json({ success: false, error: "Failed to update post" });
    }
  },
);

router.delete(
  "/posts/:id",
  authMiddleware,
  adminMiddleware,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const deleted = await deletePost(parseInt(req.params.id));
      if (!deleted) {
        res.status(404).json({ success: false, error: "Post not found" });
        return;
      }
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: "Failed to delete post" });
    }
  },
);

// ============================================
// Comment Routes
// ============================================

router.get(
  "/posts/:id/comments",
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const comments = await getCommentsByPostId(parseInt(req.params.id));
      res.json({ success: true, data: comments });
    } catch (error) {
      res
        .status(500)
        .json({ success: false, error: "Failed to fetch comments" });
    }
  },
);

router.post(
  "/posts/:id/comments",
  authMiddleware,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { body } = req.body;
      const comment = await createComment(
        parseInt(req.params.id),
        req.user!.userId,
        body,
      );
      res.status(201).json({ success: true, data: comment });
    } catch (error) {
      res
        .status(500)
        .json({ success: false, error: "Failed to create comment" });
    }
  },
);

// ============================================
// User Routes
// ============================================

router.get(
  "/users",
  authMiddleware,
  adminMiddleware,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { pool } = await import("./database");
      const result = await pool.query(
        "SELECT id, email, name, role, created_at FROM users ORDER BY created_at DESC LIMIT 20",
      );
      res.json({ success: true, data: result.rows });
    } catch (error) {
      res.status(500).json({ success: false, error: "Failed to fetch users" });
    }
  },
);

export default router;
