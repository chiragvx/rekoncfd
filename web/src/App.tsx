import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { LandingPage } from "@/pages/LandingPage";
import { ExplorePage } from "@/pages/ExplorePage";
import { AirfoilGeneratorPage } from "@/pages/AirfoilGeneratorPage";
import { ToolPage } from "@/pages/ToolPage";
import { PrivacyPage } from "@/pages/PrivacyPage";
import { TermsPage } from "@/pages/TermsPage";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/explore" element={<ExplorePage />} />
        <Route path="/airfoils" element={<AirfoilGeneratorPage />} />
        {/* The download page is now the homepage's own closing section --
            old links/bookmarks still land somewhere sensible instead of 404ing. */}
        <Route path="/download" element={<Navigate to="/#download" replace />} />
        <Route path="/tool" element={<ToolPage />} />
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="/terms" element={<TermsPage />} />
      </Routes>
    </BrowserRouter>
  );
}
