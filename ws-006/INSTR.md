we're manually testing the doordash latchkey curl api and also creating a cheatsheet of useful API queries and their sharp edges.

start with the following flows:
* fetch all carts
* fetch names of restaurants
* fetch details attached to an item
* create a new cart
* add an item to a cart, without destroying the existing contents in the cart
* add an item to a cart with configured options

Consult ~/code/doordash-mcp for probably out-of-date starting point on their graphql.

Consult ../ws-002/*.md for details on how to use curl chrom136 to impersonate.


