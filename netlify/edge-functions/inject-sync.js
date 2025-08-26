export default async (request, context) => {
  const response = await context.next();
  const ct = response.headers.get("content-type") || "";
  if (!ct.includes("text/html")) return response;

  return new HTMLRewriter()
    .on("head", {
      element(el) {
        el.append('<script src="/sync.js" defer></script>', { html: true });
      }
    })
    .transform(response);
};

export const config = { path: "/*" };
