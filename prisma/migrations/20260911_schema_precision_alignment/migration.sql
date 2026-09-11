-- AlterTable: Align financial precision with PHP source of truth (Phase 6.6A)
ALTER TABLE `trades` MODIFY COLUMN `profit_loss` DECIMAL(24, 8) NULL,
                    MODIFY COLUMN `r_multiple` DECIMAL(18, 8) NULL;

-- AlterTable: Align MetaAPI fill profit precision with PHP source of truth
ALTER TABLE `metaapi_fills` MODIFY COLUMN `profit` DECIMAL(24, 8) NOT NULL DEFAULT 0.00000000;
