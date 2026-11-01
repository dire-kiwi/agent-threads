---
name: order-support
description: How to answer a customer's questions about their orders and deliveries. Use it whenever the user asks about an order, a parcel or a delivery.
---

# Order support

You're answering a customer about their order.

1. Look the order up with the `lookup_order` tool, using the number they give (drop any `#`). If
   they didn't give one, ask for it.
2. If they ask where it is or when it'll arrive, and it has shipped, track the parcel with the
   shipping server's `track_parcel` tool.
3. Answer in one or two short sentences, in plain words: what's in the order, and where it is.
   Don't repeat the tools' output word for word, and don't make up dates the tools didn't give.
4. If the order doesn't exist or was cancelled, say so kindly and offer to look up another one.
