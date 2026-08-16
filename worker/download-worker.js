// Cloudflare Worker: verifies a Stripe payment, then allows a limited
// number of downloads of the book PDF tied to that specific purchase.
//
// Routes (bind this Worker to a Route like transhumanist.joelann.com/download*):
//   GET /download?session_id=xxx        -> themed confirmation page with a download button
//   GET /download/file?session_id=xxx   -> streams the PDF (counts against the download limit)
//
// Bindings required (Worker Settings -> Variables and Secrets / Bindings):
//   R2 bucket        BOOKS       -> your R2 bucket holding the PDF
//   KV namespace     DOWNLOADS   -> tracks per-purchase download counts
//   Secret           STRIPE_SECRET_KEY -> your Stripe secret key (sk_live_... or sk_test_...)
//
// Config below: object key in R2, max downloads allowed per purchase.

const BOOK_OBJECT_KEY = "transhumanist-en.pdf";
const MAX_DOWNLOADS = 3;
const SUPPORT_URL = "https://transhumanist.joelann.com/#contact";

function page(title, bodyHtml, status = 200) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} | TRANSHUMANIST</title>
<style>
  body{background:#030B18;color:#D8E8F5;font-family:sans-serif;min-height:100vh;
    display:flex;align-items:center;justify-content:center;text-align:center;padding:32px;margin:0;}
  .card{max-width:480px;}
  h1{font-size:24px;color:#fff;margin-bottom:16px;letter-spacing:1px;}
  p{font-size:16px;line-height:1.7;color:#D8E8F5;margin-bottom:24px;}
  a.btn{background:linear-gradient(135deg,#00C8FF,#0080CC);color:#030B18;padding:16px 36px;
    font-weight:700;letter-spacing:2px;text-decoration:none;display:inline-block;border-radius:2px;
    font-size:13px;}
  a.support{color:#00C8FF;}
</style>
</head>
<body><div class="card">${bodyHtml}</div></body>
</html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html;charset=UTF-8" } });
}

function errorPage(message) {
  return page(
    "Download",
    `<h1>Something's not right</h1><p>${message}</p><p>Need help? <a class="support" href="${SUPPORT_URL}">Contact us</a> with your order confirmation and we'll sort it out.</p>`,
    400
  );
}

async function verifyStripeSession(sessionId, env) {
  const stripeKey = typeof env.STRIPE_SECRET_KEY === "string"
    ? env.STRIPE_SECRET_KEY
    : await env.STRIPE_SECRET_KEY.get();
  const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
    headers: { Authorization: `Bearer ${stripeKey}` },
  });
  if (!res.ok) {
    console.error("Stripe verify failed", res.status, await res.text());
    return null;
  }
  return res.json();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get("session_id");

    if (!sessionId) {
      return errorPage("This link is missing purchase information. Please use the download link from your purchase confirmation.");
    }

    const session = await verifyStripeSession(sessionId, env);
    if (!session) {
      return errorPage("We couldn't verify this purchase. The link may be invalid.");
    }
    if (session.payment_status !== "paid") {
      return errorPage("This purchase hasn't completed yet. If you just paid, wait a moment and refresh.");
    }

    const kvKey = `dl:${sessionId}`;

    if (url.pathname === "/download/file") {
      const record = (await env.DOWNLOADS.get(kvKey, "json")) || { count: 0 };
      if (record.count >= MAX_DOWNLOADS) {
        return errorPage(
          `This download link has reached its limit (${MAX_DOWNLOADS} downloads). <a class="support" href="${SUPPORT_URL}">Contact us</a> with your order confirmation and we'll help you out.`
        );
      }
      const obj = await env.BOOKS.get(BOOK_OBJECT_KEY);
      if (!obj) {
        return errorPage("The file couldn't be found. Please contact support — this is on us, not you.");
      }
      await env.DOWNLOADS.put(
        kvKey,
        JSON.stringify({ count: record.count + 1, last: Date.now() }),
        { expirationTtl: 60 * 60 * 24 * 90 } // keep the counter for 90 days
      );
      return new Response(obj.body, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": 'attachment; filename="TRANSHUMANIST-Joe-Lann.pdf"',
        },
      });
    }

    if (url.pathname === "/download") {
      return page(
        "Thank you",
        `<h1>✓ Thank you for your purchase!</h1>
         <p>Your copy of TRANSHUMANIST is ready. Click below to download the PDF.</p>
         <a class="btn" href="/download/file?session_id=${encodeURIComponent(sessionId)}">↓ DOWNLOAD PDF</a>
         <p style="margin-top:24px;font-size:13px;color:#7A9BB5;">This link works up to ${MAX_DOWNLOADS} times, so you can re-download if needed. Trouble? <a class="support" href="${SUPPORT_URL}">Contact us</a>.</p>`
      );
    }

    return new Response("Not found", { status: 404 });
  },
};
