import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { Crash } from "./app/Crash";
import "./styles/globals.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Crash>
      <App />
    </Crash>
  </React.StrictMode>,
);
