import "./styles.css";
import { start } from "./ui/app.js";

void start().catch((error: unknown) => {
  const status = document.getElementById("status");
  if (status !== null) {
    status.textContent = error instanceof Error ? error.message : String(error);
  }
});
