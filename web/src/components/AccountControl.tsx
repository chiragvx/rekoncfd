import { useState } from "react";
import { LogOut, User as UserIcon } from "lucide-react";

import { isSupabaseConfigured } from "@/lib/supabase";
import { useAuth, signOut } from "@/lib/auth";
import { AuthModal } from "@/components/AuthModal";
import { Button } from "@/components/ui/button";

/** Sign-in entry point for `ToolNav` -- renders nothing at all until a
 * Supabase project is actually connected (see `lib/supabase.ts`), so it's
 * safe to mount this unconditionally in the meantime rather than gating it
 * at every call site. */
export function AccountControl() {
  const { user, loading } = useAuth();
  const [modalOpen, setModalOpen] = useState(false);

  if (!isSupabaseConfigured) return null;
  if (loading) return null;

  if (!user) {
    return (
      <>
        <Button size="sm" variant="outline" onClick={() => setModalOpen(true)}>
          Sign in
        </Button>
        {modalOpen && <AuthModal onClose={() => setModalOpen(false)} />}
      </>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <UserIcon className="size-3.5" />
        {user.email}
      </span>
      <button
        type="button"
        onClick={() => signOut()}
        title="Sign out"
        className="text-muted-foreground hover:text-foreground rounded-md p-1.5 transition-colors"
      >
        <LogOut className="size-3.5" />
      </button>
    </div>
  );
}
