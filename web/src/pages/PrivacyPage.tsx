import { LegalLayout } from "@/components/LegalLayout";

export function PrivacyPage() {
  return (
    <LegalLayout title="Privacy Policy" updated="August 25, 2026">
      <section>
        <p>
          Rekon is a free, source-available aerodynamic analysis tool for RC flying wings, published by Rekon
          ("Rekon", "we"). This page explains what data Rekon collects, why, and how you can control it. It covers
          both the hosted preview at rekoncfd.vercel.app and the downloadable desktop app.
        </p>
      </section>

      <section>
        <h2>The short version</h2>
        <ul>
          <li>A free account (email or GitHub sign-in) is currently required to use the tool.</li>
          <li>The desktop app solves everything locally on your machine; your wing geometry is never uploaded anywhere unless you explicitly save a project.</li>
          <li>Rekon runs no advertising trackers. The only analytics is Vercel's privacy-friendly, cookieless page-view counter (see below) — no cross-site tracking, no ad networks.</li>
          <li>You can delete your saved projects yourself at any time (see "Your controls" below).</li>
        </ul>
      </section>

      <section>
        <h2>What Rekon collects</h2>
        <p>
          <strong className="text-foreground">Before you sign in:</strong> visiting the homepage or browsing the
          marketing pages collects nothing beyond ordinary web-hosting logs (IP address, user agent, request timing),
          retained briefly by our hosting provider, Vercel, as part of normal infrastructure operation — not by
          Rekon directly, and not for tracking. The tool itself requires signing in, at which point the following
          applies.
        </p>
        <p>
          <strong className="text-foreground">Once you sign in:</strong> account and project storage is handled by
          Supabase. Depending on how you sign in, we hold your email address (email/password sign-in) or your public
          GitHub profile info — username, avatar, and the email GitHub shares under its standard OAuth consent screen
          (GitHub sign-in). The panel-method and lattice-Boltzmann solvers themselves only ever run on your own
          machine, inside the downloaded desktop app — the hosted preview has no backend of its own to solve
          anything, and signing in doesn't change that; it identifies you for project save/load, it doesn't route
          your geometry through our servers. If you save a project, we store what
          you saved: the wing's parametric description or an uploaded STL file, your flight-condition settings (angle
          of attack, airspeed, CG, bank), and your visualization preferences — all tied to your account and readable
          only by you (enforced by database-level row security policies, not just application code).
        </p>
        <p>
          Separately from project storage, we also keep a basic record of your sign-up itself — email, name/avatar if
          you signed in with GitHub, and when you signed up and last signed in — so we have a way to reach current
          account holders about product updates or account-affecting changes, and so we're not entirely dependent on
          browsing Supabase's own auth records to know who's using Rekon. It's deleted automatically if your account
          is deleted.
        </p>
        <p>
          <strong className="text-foreground">If you sign up for update emails:</strong> just the email address you
          give us, used solely to send occasional product updates. Never sold or shared, and you can unsubscribe at
          any time.
        </p>
        <p>
          <strong className="text-foreground">The desktop app</strong> checks GitHub's public Releases API on launch
          to see if a newer version exists — a request to GitHub, not to Rekon. No usage telemetry is sent from the
          desktop app back to us.
        </p>
      </section>

      <section>
        <h2>Cookies &amp; local storage</h2>
        <p>
          Rekon doesn't set advertising or cross-site tracking cookies. If you sign in, Supabase stores your session
          token in your browser's local storage so you stay signed in between visits. The site also remembers a
          couple of small, non-identifying preferences locally in your browser — for example, whether you've already
          downloaded the desktop app, so you're not prompted again. None of this leaves your browser or is used to
          track you across other sites.
        </p>
        <p>
          Page views are counted by Vercel Analytics, which doesn't use cookies and doesn't build a profile of you
          across sites — it reports aggregate traffic (which pages, how many visits) rather than identifying
          individual visitors.
        </p>
        <p>
          This page's fonts are loaded from Google Fonts, which — like any web font CDN — receives your IP address
          and browser details as part of that request, under Google's own privacy policy.
        </p>
      </section>

      <section>
        <h2>Who else sees your data</h2>
        <ul>
          <li><strong className="text-foreground">Supabase</strong> — hosts authentication, the project database, and stored files, if you sign in.</li>
          <li><strong className="text-foreground">Vercel</strong> — hosts the web page itself and provides its cookieless page-view analytics.</li>
          <li><strong className="text-foreground">GitHub</strong> — provides GitHub sign-in (if you use it) and hosts the app's release downloads and public source code.</li>
        </ul>
        <p>We don't sell your data, and we don't share it with anyone else for advertising purposes.</p>
      </section>

      <section>
        <h2>Your controls</h2>
        <ul>
          <li>Sign out at any time from the account menu.</li>
          <li>
            Delete all of your saved projects (and their stored files) yourself, instantly, from the account menu's
            delete icon — no need to contact anyone.
          </li>
          <li>
            To fully close your account (delete your login/email record itself), open an issue at{" "}
            <a href="https://github.com/chiragvx/rekoncfd/issues" target="_blank" rel="noreferrer">
              github.com/chiragvx/rekoncfd/issues
            </a>{" "}
            or a private security advisory if you'd rather not do it publicly, and we'll remove it.
          </li>
        </ul>
      </section>

      <section>
        <h2>Changes to this policy</h2>
        <p>
          If this policy changes materially, the "Last updated" date above will change. Material changes affecting
          signed-in users will also be noted in the app.
        </p>
      </section>

      <section>
        <h2>Contact</h2>
        <p>
          Questions about this policy or your data:{" "}
          <a href="https://github.com/chiragvx/rekoncfd/issues" target="_blank" rel="noreferrer">
            open an issue on GitHub
          </a>
          .
        </p>
      </section>
    </LegalLayout>
  );
}
