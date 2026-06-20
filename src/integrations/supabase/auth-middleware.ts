import { createMiddleware } from "@tanstack/react-start";

// Mock middleware for local development without Supabase
export const requireSupabaseAuth = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    // Inject a fixed user ID for local mode
    return next({
      context: {
        supabase: null as any,
        userId: "local-user-id",
        claims: { sub: "local-user-id" },
      },
    });
  },
);
