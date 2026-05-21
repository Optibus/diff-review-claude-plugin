import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "react-diff-view/style/index.css";
import "./main.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(<StrictMode><App /></StrictMode>);
