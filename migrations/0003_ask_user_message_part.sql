ALTER TABLE "message_parts" DROP CONSTRAINT "message_parts_kind_check";
ALTER TABLE "message_parts" ADD CONSTRAINT "message_parts_kind_check" CHECK ("kind" IN ('text', 'image', 'product_reference', 'tool_status', 'ask_user'));
