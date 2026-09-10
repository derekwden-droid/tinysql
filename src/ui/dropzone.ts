/**
 * Whole-window CSV drop target. Uses a counter because dragenter/dragleave fire
 * for every child element the pointer crosses.
 */
export function installDropzone(
  highlightTarget: HTMLElement,
  onFiles: (files: File[]) => void,
): void {
  let depth = 0;

  const clear = (): void => {
    depth = 0;
    highlightTarget.classList.remove("drop-target");
  };

  window.addEventListener("dragenter", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth++;
    highlightTarget.classList.add("drop-target");
  });

  window.addEventListener("dragover", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "copy";
  });

  window.addEventListener("dragleave", (event) => {
    if (!hasFiles(event)) return;
    depth--;
    if (depth <= 0) clear();
  });

  window.addEventListener("drop", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    clear();
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length > 0) onFiles(files);
  });
}

function hasFiles(event: DragEvent): boolean {
  return [...(event.dataTransfer?.types ?? [])].includes("Files");
}
