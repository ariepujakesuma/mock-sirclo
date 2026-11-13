// Creacon BE <-> Sirclo translator. No dependencies.
//
// metaToSirclo(metaWebhookBody)  -> Infobip-style body to POST to Sirclo /api/webhook (or null if nothing to forward)
// sircloToMeta(sircloReplyBody)  -> body for POST https://graph.facebook.com/<ver>/<PHONE_NUMBER_ID>/messages
//
// Only call metaToSirclo for customers whose session state is wa_commerce=true.

// Meta unix seconds -> Infobip "2018-09-10T12:10:18.379+0000"
const infobipTime = ts => new Date(Number(ts) * 1000).toISOString().replace('Z', '+0000');

function translateMessage(m) {
  const context = m.context ? { from: m.context.from, id: m.context.id } : undefined;

  // NOT IN TECH DOC: format of the initial data (Step 1 "Previous Step") must be confirmed with Sirclo
  if (m.type === 'text') return { type: 'TEXT', text: m.text.body };

  if (m.type === 'interactive' && m.interactive.type === 'list_reply') {
    const r = m.interactive.list_reply;
    return { type: 'INTERACTIVE_LIST_REPLY', id: r.id, title: r.title, description: r.description, context };
  }

  if (m.type === 'interactive' && m.interactive.type === 'button_reply') {
    const r = m.interactive.button_reply;
    return { type: 'INTERACTIVE_BUTTON_REPLY', id: r.id, title: r.title, context };
  }

  if (m.type === 'order') {
    return {
      type: 'ORDER',
      catalogId: m.order.catalog_id,
      text: m.order.text,
      productItems: m.order.product_items.map(p => ({
        currency: p.currency,
        itemPrice: Number(p.item_price),
        productRetailerId: p.product_retailer_id,
        quantity: Number(p.quantity),
      })),
    };
  }

  // Other types (image, audio, location, ...) are not in the tech doc -> not forwarded
  return null;
}

function metaToSirclo(body) {
  const results = [];
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      const business = v.metadata && v.metadata.display_phone_number;
      for (const m of v.messages || []) { // statuses (sent/delivered/read) are ignored
        const message = translateMessage(m);
        if (!message) continue;
        results.push({
          from: m.from,
          to: business,
          integrationType: 'WHATSAPP',
          receivedAt: infobipTime(m.timestamp),
          messageId: m.id,
          pairedMessageId: null,
          callbackData: null,
          message,
          price: { pricePerMessage: 0, currency: 'IDR' },
        });
      }
    }
  }
  return results.length ? { results, messageCount: results.length, pendingMessageCount: 0 } : null;
}

// Sirclo content is passed through as-is (no trimming). If it exceeds Meta limits, Meta rejects it -> log the error.

function sircloToMeta({ to, content }) {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to };
  const a = content.action || {};

  if (a.catalogId) { // Step 3 Multi Product -> product_list
    return { ...base, type: 'interactive', interactive: {
      type: 'product_list',
      header: { type: 'text', text: content.header.text },
      body: { text: content.body.text },
      action: {
        catalog_id: a.catalogId,
        sections: a.sections.map(s => ({
          title: s.title,
          product_items: s.productRetailerIds.map(id => ({ product_retailer_id: id })),
        })),
      },
    } };
  }

  if (a.sections) { // Step 1 List Message -> list
    return { ...base, type: 'interactive', interactive: {
      type: 'list',
      body: { text: content.body.text },
      action: {
        button: a.title,
        sections: a.sections.map(s => ({
          ...(s.title && { title: s.title }),
          rows: s.rows.map(r => ({ id: r.id, title: r.title, ...(r.description && { description: r.description }) })),
        })),
      },
    } };
  }

  if (a.buttons) { // Step 5 Reply Button -> button
    return { ...base, type: 'interactive', interactive: {
      type: 'button',
      body: { text: content.body.text },
      action: { buttons: a.buttons.map(b => ({ type: 'reply', reply: { id: b.id, title: b.title } })) },
    } };
  }

  if (content.text) { // Step 7 Text Message (payment link)
    return { ...base, type: 'text', text: { body: content.text, preview_url: true } };
  }

  throw new Error('Unknown Sirclo payload shape');
}

module.exports = { metaToSirclo, sircloToMeta };
