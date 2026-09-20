import { parseDocument } from "htmlparser2";

interface HtmlNode {
  type: string;
  data?: string;
  name?: string;
  children?: HtmlNode[];
}

const SKIP_TAGS = new Set([
  "script",
  "style",
  "head",
  "title",
  "meta",
  "link",
  "noscript",
  "template",
]);

const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "dd",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

export const htmlToText = (html: string): string => {
  const document = parseDocument(html, { decodeEntities: true }) as unknown as HtmlNode;
  let output = "";

  const visit = (node: HtmlNode): void => {
    if (node.type === "text") {
      output += node.data ?? "";
      return;
    }
    if (node.type !== "tag") {
      return;
    }
    const name = (node.name ?? "").toLowerCase();
    if (SKIP_TAGS.has(name)) {
      return;
    }

    const isBlock = BLOCK_TAGS.has(name);
    if (isBlock && !output.endsWith("\n")) {
      output += "\n";
    }
    for (const child of node.children ?? []) {
      visit(child);
    }
    if (isBlock && !output.endsWith("\n")) {
      output += "\n";
    }
  };

  for (const child of document.children ?? []) {
    visit(child);
  }

  return output
    .replaceAll(/\r\n?/gu, "\n")
    .replaceAll(/[ \t\f\v\u00A0]+/gu, " ")
    .replaceAll(/ *\n */gu, "\n")
    .replaceAll(/\n{3,}/gu, "\n\n")
    .trim();
};
