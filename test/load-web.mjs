import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import ts from "typescript";

// The web build bundles these modules; transpile source-only imports for test runners whose Node 22
// binary was built without native TypeScript stripping (for example Ubuntu's packaged Node).
export async function loadWeb(name) {
  const source = await readFile(new URL(`../web/${name}.ts`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    fileName: `${name}.ts`,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}
