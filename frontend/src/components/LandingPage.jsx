import { useNavigate } from "react-router-dom";
import "./LandingPage.css";
import logo from "../assets/aerio-logo.png";

export default function LandingPage() {
  const navigate = useNavigate();
  const openBrowser = () => {
    navigate("/auth");
  };

  const download = (file) => {
    window.location.href = `/downloads/${file}`;
  };

  return (
    <div className="landing">
      <div className="overlay"></div>

      <main className="hero">
        <section className="hero-left">

          <div className="brand">
            <div className="logo-circle">
              <img src={logo} alt="Aerio Logo" className="logo-image" />
            </div>

            <div className="brand-title">
              <h1>Aerio</h1>
              <h3>Modern. Fast. Secure Messaging.</h3>
            </div>
          </div>

          <p className="hero-desc">
            Aerio is a modern messaging platform built for speed, privacy and
            simplicity. Chat with friends, create groups, share media and stay
            connected across Windows, macOS, Linux, Android and the Web.
          </p>

          <button className="browser-btn" onClick={openBrowser}>
            Open Now
          </button>

          <div className="download-row">

            <button
              className="download-btn"
              onClick={() => download("Aerio-Setup.exe")}
            >
              <span>🪟</span>
              Windows
            </button>

            <button
              className="download-btn"
              onClick={() => download("Aerio.dmg")}
            >
              <span>🍎</span>
              macOS
            </button>

            <button
              className="download-btn"
              onClick={() => download("Aerio.AppImage")}
            >
              <span>🐧</span>
              Linux
            </button>

            <button
              className="download-btn"
              onClick={() => download("Aerio.apk")}
            >
              <span>🤖</span>
              Android
            </button>

          </div>

          <p className="copyright">
            © 2026 Aerio. All rights reserved.
          </p>

        </section>
      </main>
    </div>
  );
}