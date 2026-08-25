import { LegalLayout } from "@/components/LegalLayout";

export function TermsPage() {
  return (
    <LegalLayout title="Terms of Use" updated="August 25, 2026">
      <section>
        <p>
          These terms cover your use of Rekon — the hosted preview at rekoncfd.vercel.app and the downloadable
          desktop app. By using either, you agree to them. If you don't agree, please don't use Rekon.
        </p>
      </section>

      <section>
        <h2>What Rekon is</h2>
        <p>
          Rekon is a free tool that estimates aerodynamic performance (lift, drag, moment, trim, stability, and flow
          field) for RC flying-wing aircraft, using a source-doublet panel method and a lattice-Boltzmann flow
          solver. It's a design aid, not a certification tool.
        </p>
      </section>

      <section>
        <h2>No warranty, use your judgment</h2>
        <p>
          Rekon is provided "as is," without warranty of any kind. Its numerical results are estimates from
          simplified physical models — they are useful for comparing design choices and catching gross errors before
          you cut foam or filament, but they are not a substitute for real flight testing, structural analysis, or
          professional engineering judgment. You are solely responsible for any RC aircraft you build or fly based on
          results from this tool, and for following all applicable aviation regulations in your jurisdiction (e.g.
          FAA Part 107/49 U.S.C. §44809 rules for RC aircraft in the US, or your local equivalent).
        </p>
      </section>

      <section>
        <h2>Accounts and your content</h2>
        <p>
          A free account is currently required to use the tool. You're responsible for keeping your account
          credentials secure. You retain ownership of any geometry, project names, and settings you save — we store
          it on your behalf to make it available to you, and don't use it for anything else. See the{" "}
          <a href="/privacy">Privacy Policy</a> for details, including how to delete it.
        </p>
        <p>
          Don't use Rekon to upload or store content you don't have the right to, or to abuse the service (e.g.
          attempting to access another user's account or data, or overwhelming the infrastructure with automated
          requests).
        </p>
      </section>

      <section>
        <h2>Open source</h2>
        <p>
          Rekon's source code is available at{" "}
          <a href="https://github.com/chiragvx/rekoncfd" target="_blank" rel="noreferrer">
            github.com/chiragvx/rekoncfd
          </a>{" "}
          under the MIT License. These Terms of Use govern your use of the hosted service and the distributed
          desktop app; the MIT License governs your rights to the source code itself, and takes precedence over
          anything here in the event of a conflict on that point.
        </p>
      </section>

      <section>
        <h2>Availability</h2>
        <p>
          The hosted preview and desktop-app update checks depend on third-party infrastructure (Vercel, Supabase,
          GitHub) and may be interrupted or discontinued. The downloaded desktop app continues to run and solve
          fully offline regardless of the hosted page's availability.
        </p>
      </section>

      <section>
        <h2>Changes</h2>
        <p>
          We may update these terms as the product changes. Continuing to use Rekon after an update means you accept
          the revised terms. The "Last updated" date above reflects the latest revision.
        </p>
      </section>

      <section>
        <h2>Contact</h2>
        <p>
          Questions about these terms:{" "}
          <a href="https://github.com/chiragvx/rekoncfd/issues" target="_blank" rel="noreferrer">
            open an issue on GitHub
          </a>
          .
        </p>
      </section>
    </LegalLayout>
  );
}
