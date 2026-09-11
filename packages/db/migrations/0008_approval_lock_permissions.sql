-- PostgreSQL row locks require UPDATE on at least one column.
-- API code changes no identifier; this enables FOR SHARE while preserving read-only commercial fields.
GRANT UPDATE(id) ON account_offer,supplier_relationship,source_product_map,procurement_product,organisation TO pharmacart_runtime;
