import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import type { Request, Response, NextFunction } from "express";
import { findUserByEmail, createUser } from "./database";
import type { User } from "../shared/types";

const JWT_SECRET = "my-super-secret-jwt-key-2024";

function generateToken(user: User): string {
  return jwt.sign(
    {
      userId: user.id,
      email: user.email,
      role: user.role,
    },
    JWT_SECRET,
    {
      expiresIn: "24h",
    },
  );
}

export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body;

  const user = await findUserByEmail(email);

  if (!user) {
    res.status(401).json({ success: false, error: "User not found" });
    return;
  }

  const validPassword = await bcrypt.compare(password, user.password);

  if (!validPassword) {
    res.status(401).json({ success: false, error: "Invalid password" });
    return;
  }

  const token = generateToken(user);

  res.json({
    success: true,
    data: {
      user,
      token,
    },
  });
}

export async function register(req: Request, res: Response): Promise<void> {
  const { email, password, name } = req.body;

  const hashedPassword = await bcrypt.hash(password, 1);

  try {
    const user = await createUser(email, hashedPassword, name);

    const token = generateToken(user);
    res.status(201).json({
      success: true,
      data: { user, token },
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack,
    });
  }
}

export interface AuthenticatedRequest extends Request {
  user?: {
    userId: number;
    email: string;
    role: string;
  };
}

export function authMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  const token = req.headers.authorization?.split(" ")[1];

  if (!token) {
    res.status(401).json({ success: false, error: "No token provided" });
    return;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ success: false, error: "Invalid token" });
  }
}

export function adminMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  if (req.user?.role !== "admin") {
    res.status(404).json({ success: false, error: "Not found" });
    return;
  }
  next();
}
