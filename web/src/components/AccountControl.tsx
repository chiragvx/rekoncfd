import { useState } from "react";
import { LogOut, Trash2, User as UserIcon } from "lucide-react";

import { isSupabaseConfigured } from "@/lib/supabase";
import { useAuth, signOut } from "@/lib/auth";
import { deleteAllProjects } from "@/lib/projects";
import { AuthModal } from "@/components/AuthModal";
import { Button } from "@/components/ui/button";

/** Sign-in entry point for `ToolNav` -- renders nothing at all until a
 * Supabase project is actually connected (see `lib/supabase.ts`), so it's
 * safe to mount this unconditionally in the meantime rather than gating it
 * at every call site. */
export function AccountControl() {
  const { user, loading } = useAuth();
  const [modalOpen, setModalOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

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

  async function handleDeleteData() {
    setDeleting(true);
    try {
      await deleteAllProjects();
      setConfirmingDelete(false);
    } catch (err) {
      // Surfaced inline rather than a toast system -- this component has
      // none -- since a failed bulk delete (e.g. one project's storage
      // remove failing) is rare enough not to warrant building one just
      // for this.
      window.alert(err instanceof Error ? err.message : "Couldn't delete your projects. Try again.");
    } finally {
      setDeleting(false);
    }
  }

  if (confirmingDelete) {
    return (
      <div className="border-destructive/40 bg-destructive/10 flex items-center gap-2 rounded-md border px-2 py-1">
        <span className="text-destructive text-xs">Delete all saved projects? This can't be undone.</span>
        <Button size="sm" variant="destructive" disabled={deleting} onClick={handleDeleteData}>
          {deleting ? "Deleting…" : "Delete"}
        </Button>
        <Button size="sm" variant="ghost" disabled={deleting} onClick={() => setConfirmingDelete(false)}>
          Cancel
        </Button>
      </div>
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
        onClick={() => setConfirmingDelete(true)}
        title="Delete all saved projects"
        className="text-muted-foreground hover:text-destructive rounded-md p-1.5 transition-colors"
      >
        <Trash2 className="size-3.5" />
      </button>
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
