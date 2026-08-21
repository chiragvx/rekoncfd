import { BrowserRouter, Route, Routes } from "react-router-dom";

import { LandingPage } from "@/pages/LandingPage";
import { ExplorePage } from "@/pages/ExplorePage";
import { AirfoilGeneratorPage } from "@/pages/AirfoilGeneratorPage";
import { DownloadPage } from "@/pages/DownloadPage";
import { ToolPage } from "@/pages/ToolPage";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/explore" element={<ExplorePage />} />
        <Route path="/airfoils" element={<AirfoilGeneratorPage />} />
        <Route path="/download" element={<DownloadPage />} />
        <Route path="/tool" element={<ToolPage />} />
      </Routes>
    </BrowserRouter>
  );
}
