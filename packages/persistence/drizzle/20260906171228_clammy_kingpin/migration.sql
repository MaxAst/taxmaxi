ALTER TABLE "principal_transaction_overrides" ADD COLUMN "inspected_valuation_evidence" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "principal_transaction_overrides" ADD CONSTRAINT "principal_transaction_overrides_valuation_evidence" CHECK ((jsonb_typeof("inspected_valuation_evidence") = 'object'
        and "inspected_valuation_evidence" - ARRAY['reportingCurrency','facts'] = '{}'::jsonb
        and "inspected_valuation_evidence"->>'reportingCurrency' in ('USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'CNY', 'HKD', 'SGD', 'KRW', 'KWD', 'BHD', 'OMR', 'CLF')
        and jsonb_typeof("inspected_valuation_evidence"->'facts') = 'array'
        and jsonb_array_length(jsonb_path_query_array("inspected_valuation_evidence"->'facts', 'strict $[*] ? (@.type() == "object" && (@._tag == "observed_consideration" || @._tag == "market_quote"))')) = jsonb_array_length("inspected_valuation_evidence"->'facts')) is true);