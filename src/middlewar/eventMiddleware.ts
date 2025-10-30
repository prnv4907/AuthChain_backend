import type { NextFunction, Request, Response } from "express";
export const eventMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const providedSecret = req.headers["authorization"];
  const actualSecret = process.env.HELIUS_SECRET;
  if (!providedSecret || providedSecret != actualSecret) {
    console.warn("Unauthorized webhoot attempt block");
    return res.status(403).json({
      message: "forbidden",
    });
    next();
  }
};
