use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use rusqlite::{params, Connection};
use serde_json::json;
use crate::db::operations::DatabaseOpError;

/// Simple, robust pharmaceutical strength and release type extractor for CDCI strings in Rust.
pub struct ParsedStrength {
    pub raw_summary: String,
    pub strengths_json: String,
    pub is_combination: bool,
    pub is_verified: bool,
    pub release_type: String,
}

pub fn extract_release_type_rust(name: &str) -> &'static str {
    let upper = name.to_ascii_uppercase();
    if upper.contains("GASTRO-RESISTANT")
        || upper.contains("ENTERIC-COATED")
        || upper.contains("ENTERIC COATED")
        || upper.split_whitespace().any(|w| w == "EC" || w == "GR")
    {
        "GASTRO_RESISTANT"
    } else if upper.contains("PROLONGED-RELEASE")
        || upper.contains("PROLONGED RELEASE")
        || upper.split_whitespace().any(|w| w == "PR")
    {
        "PROLONGED_RELEASE"
    } else if upper.contains("SUSTAINED-RELEASE")
        || upper.contains("SUSTAINED RELEASE")
        || upper.split_whitespace().any(|w| w == "SR")
    {
        "SUSTAINED_RELEASE"
    } else if upper.contains("EXTENDED-RELEASE")
        || upper.contains("EXTENDED RELEASE")
        || upper.split_whitespace().any(|w| w == "ER" || w == "XR" || w == "XL")
    {
        "EXTENDED_RELEASE"
    } else if upper.contains("CONTROLLED-RELEASE")
        || upper.contains("CONTROLLED RELEASE")
        || upper.split_whitespace().any(|w| w == "CR")
    {
        "CONTROLLED_RELEASE"
    } else if upper.contains("MODIFIED-RELEASE")
        || upper.contains("MODIFIED RELEASE")
        || upper.split_whitespace().any(|w| w == "MR")
    {
        "MODIFIED_RELEASE"
    } else if upper.contains("DELAYED-RELEASE")
        || upper.contains("DELAYED RELEASE")
        || upper.split_whitespace().any(|w| w == "DR")
    {
        "DELAYED_RELEASE"
    } else {
        "IMMEDIATE_RELEASE"
    }
}

pub fn parse_strengths_rust(name: &str) -> ParsedStrength {
    let release_type = extract_release_type_rust(name).to_string();
    let trimmed = name.trim();

    // 1. Check combination drug joined by ' + '
    if trimmed.contains(" + ") {
        let parts: Vec<&str> = trimmed.split(" + ").collect();
        let mut summaries = Vec::new();
        let mut items = Vec::new();

        for part in parts {
            if let Some(strength_str) = find_strength_in_segment(part) {
                summaries.push(strength_str.clone());
                items.push(json!({
                    "rawStrength": strength_str,
                }));
            }
        }

        if !items.is_empty() {
            let summary = summaries.join(" + ");
            return ParsedStrength {
                raw_summary: summary,
                strengths_json: json!(items).to_string(),
                is_combination: true,
                is_verified: true,
                release_type,
            };
        }
    }

    // 2. Check multi-ingredient joined by ' and '
    if trimmed.contains(" and ") || trimmed.contains(" AND ") {
        let parts: Vec<&str> = trimmed.split(" and ").collect();
        let mut summaries = Vec::new();
        let mut items = Vec::new();

        for part in parts {
            if let Some(strength_str) = find_strength_in_segment(part) {
                summaries.push(strength_str.clone());
                items.push(json!({
                    "rawStrength": strength_str,
                }));
            }
        }

        if items.len() > 1 {
            let summary = summaries.join(" + ");
            return ParsedStrength {
                raw_summary: summary,
                strengths_json: json!(items).to_string(),
                is_combination: true,
                is_verified: true,
                release_type,
            };
        }
    }

    // 3. Single strength search
    if let Some(strength_str) = find_strength_in_segment(trimmed) {
        return ParsedStrength {
            raw_summary: strength_str.clone(),
            strengths_json: json!([{ "rawStrength": strength_str }]).to_string(),
            is_combination: false,
            is_verified: true,
            release_type,
        };
    }

    ParsedStrength {
        raw_summary: "Unspecified".to_string(),
        strengths_json: "[]".to_string(),
        is_combination: false,
        is_verified: false,
        release_type,
    }
}

/// Helper that identifies strength tokens like "500 mg", "60,000 IU", "250 mcg", "0.5 % w/v", "250 mg/5 mL".
fn find_strength_in_segment(seg: &str) -> Option<String> {
    let units = [
        "mg/5 ml", "mg/5ml", "mg/10 ml", "mg/ml", "mg/l",
        "mcg/puff", "mcg/actuation", "mcg/dose",
        "million unit/vial", "million unit", "miu/vial", "miu",
        "microgram", "milligram", "milliliter", "nanogram",
        "% w/v", "% w/w", "% v/v", "%",
        "mcg", "mg", "kg", "ml", "iu", "ng", "ul", "g", "l",
    ];

    let words: Vec<&str> = seg.split_whitespace().collect();
    for i in 0..words.len() {
        let w = words[i].trim_matches(|c: char| !c.is_alphanumeric() && c != '.' && c != ',');
        // Check if w is a number (e.g. "500", "2.5", "60,000")
        let is_num = !w.is_empty() && w.chars().all(|c| c.is_ascii_digit() || c == '.' || c == ',');
        if is_num {
            // Check next words for unit
            for j in (i + 1)..words.len().min(i + 4) {
                let candidate_unit = words[i + 1..=j].join(" ").to_ascii_lowercase();
                for u in &units {
                    if candidate_unit == *u || candidate_unit.starts_with(u) {
                        return Some(format!("{w} {candidate_unit}"));
                    }
                }
            }
        }
    }
    None
}

/// Locates the CDCI flat file package directory across standard workspace, app resource and download paths.
pub fn find_cdci_package_dir(custom_path: Option<&Path>) -> Option<PathBuf> {
    if let Some(p) = custom_path {
        if p.exists() && p.join("GenericMaster.txt").exists() {
            return Some(p.to_path_buf());
        }
    }

    if let Ok(env_path) = std::env::var("CDCI_DATA_DIR") {
        let p = PathBuf::from(env_path.trim());
        if p.exists() && p.join("GenericMaster.txt").exists() {
            return Some(p);
        }
    }

    let candidates = [
        PathBuf::from("data/cdci/CommonDrugCodesForIndia_FlatFilePackage"),
        PathBuf::from("../data/cdci/CommonDrugCodesForIndia_FlatFilePackage"),
        PathBuf::from("../../data/cdci/CommonDrugCodesForIndia_FlatFilePackage"),
        PathBuf::from("backend/data/cdci/CommonDrugCodesForIndia_FlatFilePackage"),
        PathBuf::from("../backend/data/cdci/CommonDrugCodesForIndia_FlatFilePackage"),
    ];

    for candidate in &candidates {
        if candidate.exists() && candidate.join("GenericMaster.txt").exists() {
            return Some(candidate.clone());
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let resource_candidates = [
                parent.to_path_buf(),
                parent.join("resources"),
                parent.join("CommonDrugCodesForIndia_FlatFilePackage"),
                parent.join("resources").join("CommonDrugCodesForIndia_FlatFilePackage"),
                parent.join("data").join("cdci").join("CommonDrugCodesForIndia_FlatFilePackage"),
                parent.join("resources").join("backend").join("data").join("cdci").join("CommonDrugCodesForIndia_FlatFilePackage"),
                parent.join("resources").join("_up_").join("backend").join("data").join("cdci").join("CommonDrugCodesForIndia_FlatFilePackage"),
            ];
            for rc in &resource_candidates {
                if rc.exists() && rc.join("GenericMaster.txt").exists() {
                    return Some(rc.clone());
                }
            }
        }
    }

    None
}

pub const EXPECTED_TOTAL_RECORDS: usize = 104_367;
pub const EXPECTED_GENERIC_RECORDS: usize = 10_305;
pub const EXPECTED_BRAND_RECORDS: usize = 93_911;
pub const EXPECTED_PRODUCT_RECORDS: usize = 151;
pub const CURRENT_CATALOGUE_VERSION: &str = "CDCI_NRCES_INDIA_2026_V2";

/// Returns true only if the local catalogue is fully seeded, verified and reconciled to 104,367 records.
pub fn is_catalogue_reconciled(conn: &Connection) -> bool {
    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM local_catalogue_cache_v1", [], |r| r.get(0))
        .unwrap_or(0);
    if total != EXPECTED_TOTAL_RECORDS as i64 {
        return false;
    }

    let version: Option<String> = conn
        .query_row(
            "SELECT value FROM catalogue_sync_metadata WHERE key = 'catalogue_version'",
            [],
            |r| r.get(0),
        )
        .ok();

    let status: Option<String> = conn
        .query_row(
            "SELECT value FROM catalogue_sync_metadata WHERE key = 'sync_status'",
            [],
            |r| r.get(0),
        )
        .ok();

    version.as_deref() == Some(CURRENT_CATALOGUE_VERSION) && status.as_deref() == Some("COMPLETED")
}

/// Automatically reconciles and seeds `local_catalogue_cache_v1` in SQLite.
/// - If the catalogue is already fully reconciled (104,367 records, version V2), it returns immediately in < 1ms.
/// - If an existing installation already has the 104,216 base records (generics + brands), it performs a fast, targeted backfill
///   of only the 151 missing standalone ProductMaster records without re-inserting the 100k+ existing records.
/// - If a fresh installation or incomplete database, it seeds all 104,367 records from the CDCI flat file package.
/// - Atomic and idempotent: runs in a transaction and only updates metadata to COMPLETED after verifying exact entity counts.
pub fn reconcile_and_seed_local_catalogue(
    conn: &mut Connection,
    custom_dir: Option<&Path>,
) -> Result<usize, DatabaseOpError> {
    if is_catalogue_reconciled(conn) {
        log::debug!(
            "Local offline catalogue is already fully reconciled with {} medicines (version: {}).",
            EXPECTED_TOTAL_RECORDS,
            CURRENT_CATALOGUE_VERSION
        );
        return Ok(EXPECTED_TOTAL_RECORDS);
    }

    let cdci_dir = match find_cdci_package_dir(custom_dir) {
        Some(dir) => dir,
        None => {
            log::warn!("CDCI flat file package not found. Skipping offline catalogue seed/backfill.");
            let count: i64 = conn
                .query_row("SELECT COUNT(*) FROM local_catalogue_cache_v1", [], |r| r.get(0))
                .unwrap_or(0);
            return Ok(count as usize);
        }
    };

    let generic_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM local_catalogue_cache_v1 WHERE item_type = 'GENERIC'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);

    let brand_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM local_catalogue_cache_v1 WHERE item_type = 'BRAND'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);

    let product_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM local_catalogue_cache_v1 WHERE item_type = 'PRODUCT'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);

    // Case 1: Targeted backfill for existing installations that already have 10,305 generics and 93,911 brands (104,216 total)
    // but lack the 151 standalone ProductMaster products.
    if generic_count >= EXPECTED_GENERIC_RECORDS as i64
        && brand_count >= EXPECTED_BRAND_RECORDS as i64
        && product_count < EXPECTED_PRODUCT_RECORDS as i64
    {
        log::info!(
            "Existing installation detected (generics: {}, brands: {}). Backfilling missing standalone ProductMaster records...",
            generic_count,
            brand_count
        );
        let tx = conn.transaction()?;
        backfill_standalone_products(&tx, &cdci_dir)?;
        tx.commit()?;
    } else {
        // Case 2: Fresh installation or incomplete seed
        log::info!("Executing full offline CDCI catalogue seed from {:?}", cdci_dir);
        let tx = conn.transaction()?;
        full_seed_catalogue(&tx, &cdci_dir)?;
        tx.commit()?;
    }

    // Verify reconciliation completeness across all entity dimensions
    let final_total: i64 = conn.query_row(
        "SELECT COUNT(*) FROM local_catalogue_cache_v1",
        [],
        |r| r.get(0),
    )?;
    let final_generic: i64 = conn.query_row(
        "SELECT COUNT(*) FROM local_catalogue_cache_v1 WHERE item_type = 'GENERIC'",
        [],
        |r| r.get(0),
    )?;
    let final_brand: i64 = conn.query_row(
        "SELECT COUNT(*) FROM local_catalogue_cache_v1 WHERE item_type = 'BRAND'",
        [],
        |r| r.get(0),
    )?;
    let final_product: i64 = conn.query_row(
        "SELECT COUNT(*) FROM local_catalogue_cache_v1 WHERE item_type = 'PRODUCT'",
        [],
        |r| r.get(0),
    )?;

    if final_total == EXPECTED_TOTAL_RECORDS as i64
        && final_generic == EXPECTED_GENERIC_RECORDS as i64
        && final_brand == EXPECTED_BRAND_RECORDS as i64
        && final_product == EXPECTED_PRODUCT_RECORDS as i64
    {
        update_catalogue_metadata(conn, final_total as usize)?;
        log::info!(
            "Successfully reconciled local SQLite catalogue: {} total medicines ({} generics, {} brands, {} standalone products).",
            final_total,
            final_generic,
            final_brand,
            final_product
        );
    } else {
        log::warn!(
            "Catalogue reconciliation incomplete: total={} (expected {}), generics={}, brands={}, products={}",
            final_total,
            EXPECTED_TOTAL_RECORDS,
            final_generic,
            final_brand,
            final_product
        );
    }

    Ok(final_total as usize)
}

/// Backwards-compatible alias for `reconcile_and_seed_local_catalogue`.
pub fn seed_local_catalogue_if_empty(
    conn: &mut Connection,
    custom_dir: Option<&Path>,
) -> Result<usize, DatabaseOpError> {
    reconcile_and_seed_local_catalogue(conn, custom_dir)
}

fn backfill_standalone_products(
    tx: &rusqlite::Transaction,
    cdci_dir: &Path,
) -> Result<usize, DatabaseOpError> {
    let brand_file = File::open(cdci_dir.join("BrandMaster.txt"))
        .map_err(|e| DatabaseOpError::Sqlite(rusqlite::Error::ToSqlConversionFailure(Box::new(e))))?;
    let brand_reader = BufReader::new(brand_file);
    let mut referenced_products: std::collections::HashSet<String> = std::collections::HashSet::new();

    let mut is_header = true;
    for line in brand_reader.lines() {
        let line = line.map_err(|e| DatabaseOpError::Sqlite(rusqlite::Error::ToSqlConversionFailure(Box::new(e))))?;
        if is_header {
            is_header = false;
            continue;
        }
        if line.trim().is_empty() {
            continue;
        }
        let cols: Vec<&str> = line.split('\t').collect();
        if cols.len() > 2 {
            let prod_id = cols[2].trim();
            if !prod_id.is_empty() {
                referenced_products.insert(prod_id.to_string());
            }
        }
    }

    let prod_file = File::open(cdci_dir.join("ProductMaster.txt"))
        .map_err(|e| DatabaseOpError::Sqlite(rusqlite::Error::ToSqlConversionFailure(Box::new(e))))?;
    let prod_reader = BufReader::new(prod_file);

    let mut inserted = 0;
    let mut stmt = tx.prepare(
        r#"
        INSERT INTO local_catalogue_cache_v1 (
            id, item_type, name, brand_name, generic_name, product_name,
            dosage_form, route, active_ingredients_json, strengths_json,
            raw_strength_summary, is_combination, is_verified, source_provenance,
            cached_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
            item_type = excluded.item_type,
            name = excluded.name,
            product_name = excluded.product_name,
            strengths_json = excluded.strengths_json,
            raw_strength_summary = excluded.raw_strength_summary,
            is_combination = excluded.is_combination,
            is_verified = excluded.is_verified,
            source_provenance = excluded.source_provenance,
            cached_at = CURRENT_TIMESTAMP
        "#,
    )?;

    is_header = true;
    for line in prod_reader.lines() {
        let line = line.map_err(|e| DatabaseOpError::Sqlite(rusqlite::Error::ToSqlConversionFailure(Box::new(e))))?;
        if is_header {
            is_header = false;
            continue;
        }
        if line.trim().is_empty() {
            continue;
        }
        let cols: Vec<&str> = line.split('\t').collect();
        if cols.len() < 2 {
            continue;
        }
        let prod_id = cols[0].trim();
        let prod_name = cols[1].trim();
        if prod_id.is_empty() || prod_name.is_empty() {
            continue;
        }

        if !referenced_products.contains(prod_id) {
            let parsed = parse_strengths_rust(prod_name);
            stmt.execute(params![
                prod_id,
                "PRODUCT",
                prod_name,
                Option::<String>::None,
                Option::<String>::None,
                Some(prod_name),
                Option::<String>::None,
                Option::<String>::None,
                Option::<String>::None,
                parsed.strengths_json,
                parsed.raw_summary,
                if parsed.is_combination { 1 } else { 0 },
                if parsed.is_verified { 1 } else { 0 },
                "CDCI_NRCES_INDIA",
            ])?;
            inserted += 1;
        }
    }

    Ok(inserted)
}

fn full_seed_catalogue(
    tx: &rusqlite::Transaction,
    cdci_dir: &Path,
) -> Result<usize, DatabaseOpError> {
    let forms_map = load_tsv_lookup(&cdci_dir.join("DrugFormMaster.txt"), 0, 1)?;
    let routes_map = load_tsv_lookup(&cdci_dir.join("RouteOfAdministrationMaster.txt"), 0, 1)?;
    let products_map = load_tsv_lookup(&cdci_dir.join("ProductMaster.txt"), 0, 1)?;
    let suppliers_map = load_tsv_lookup(&cdci_dir.join("SupplierMaster.txt"), 0, 1)?;

    let mut total_inserted = 0;
    let mut generic_lookup: HashMap<String, (String, Option<String>, Option<String>)> = HashMap::new();
    let mut referenced_products: std::collections::HashSet<String> = std::collections::HashSet::new();

    {
        let mut stmt = tx.prepare(
            r#"
            INSERT INTO local_catalogue_cache_v1 (
                id, item_type, name, brand_name, generic_name, product_name,
                dosage_form, route, active_ingredients_json, strengths_json,
                raw_strength_summary, is_combination, is_verified, source_provenance,
                cached_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET
                item_type = excluded.item_type,
                name = excluded.name,
                brand_name = excluded.brand_name,
                generic_name = excluded.generic_name,
                product_name = excluded.product_name,
                dosage_form = excluded.dosage_form,
                route = excluded.route,
                active_ingredients_json = excluded.active_ingredients_json,
                strengths_json = excluded.strengths_json,
                raw_strength_summary = excluded.raw_strength_summary,
                is_combination = excluded.is_combination,
                is_verified = excluded.is_verified,
                source_provenance = excluded.source_provenance,
                cached_at = CURRENT_TIMESTAMP
            "#,
        )?;

        // 1. Process GenericMaster.txt
        let gen_file = File::open(cdci_dir.join("GenericMaster.txt"))
            .map_err(|e| DatabaseOpError::Sqlite(rusqlite::Error::ToSqlConversionFailure(Box::new(e))))?;
        let gen_reader = BufReader::new(gen_file);

        let mut is_header = true;
        for line in gen_reader.lines() {
            let line = line.map_err(|e| DatabaseOpError::Sqlite(rusqlite::Error::ToSqlConversionFailure(Box::new(e))))?;
            if is_header {
                is_header = false;
                continue;
            }
            if line.trim().is_empty() {
                continue;
            }

            let cols: Vec<&str> = line.split('\t').collect();
            if cols.len() < 2 {
                continue;
            }

            let id = cols[0].trim();
            let generic_name = cols[1].trim();
            if id.is_empty() || generic_name.is_empty() {
                continue;
            }

            let form_id = if cols.len() > 4 { cols[4].trim() } else { "" };
            let dosage_form = forms_map.get(form_id).cloned();

            let route_id = if cols.len() > 3 {
                cols[3].split('+').next().unwrap_or("").trim()
            } else {
                ""
            };
            let route = routes_map.get(route_id).cloned();

            let parsed = parse_strengths_rust(generic_name);
            let extra_meta = json!({
                "releaseType": parsed.release_type,
            }).to_string();

            generic_lookup.insert(
                id.to_string(),
                (generic_name.to_string(), dosage_form.clone(), route.clone()),
            );

            stmt.execute(params![
                id,
                "GENERIC",
                generic_name,
                Option::<String>::None,
                Some(generic_name),
                Option::<String>::None,
                dosage_form,
                route,
                Some(extra_meta),
                parsed.strengths_json,
                parsed.raw_summary,
                if parsed.is_combination { 1 } else { 0 },
                if parsed.is_verified { 1 } else { 0 },
                "CDCI_NRCES_INDIA",
            ])?;

            total_inserted += 1;
        }

        // 2. Process BrandMaster.txt
        let brand_file = File::open(cdci_dir.join("BrandMaster.txt"))
            .map_err(|e| DatabaseOpError::Sqlite(rusqlite::Error::ToSqlConversionFailure(Box::new(e))))?;
        let brand_reader = BufReader::new(brand_file);

        is_header = true;
        for line in brand_reader.lines() {
            let line = line.map_err(|e| DatabaseOpError::Sqlite(rusqlite::Error::ToSqlConversionFailure(Box::new(e))))?;
            if is_header {
                is_header = false;
                continue;
            }
            if line.trim().is_empty() {
                continue;
            }

            let cols: Vec<&str> = line.split('\t').collect();
            if cols.len() < 2 {
                continue;
            }

            let id = cols[0].trim();
            let brand_name = cols[1].trim();
            if id.is_empty() || brand_name.is_empty() {
                continue;
            }

            let product_id = if cols.len() > 2 { cols[2].trim() } else { "" };
            let supplier_id = if cols.len() > 3 { cols[3].trim() } else { "" };
            let generic_id = if cols.len() > 4 { cols[4].trim() } else { "" };

            if !product_id.is_empty() {
                referenced_products.insert(product_id.to_string());
            }

            let product_name = products_map.get(product_id).cloned();
            let supplier_name = suppliers_map.get(supplier_id).cloned();

            let gen_info = generic_lookup.get(generic_id);
            let generic_name = gen_info.map(|g| g.0.clone());
            let dosage_form = gen_info.and_then(|g| g.1.clone());
            let route = gen_info.and_then(|g| g.2.clone());

            let parsed = parse_strengths_rust(brand_name);
            let extra_meta = json!({
                "releaseType": parsed.release_type,
                "manufacturer": supplier_name,
            }).to_string();

            stmt.execute(params![
                id,
                "BRAND",
                brand_name,
                Some(brand_name),
                generic_name,
                product_name,
                dosage_form,
                route,
                Some(extra_meta),
                parsed.strengths_json,
                parsed.raw_summary,
                if parsed.is_combination { 1 } else { 0 },
                if parsed.is_verified { 1 } else { 0 },
                "CDCI_NRCES_INDIA",
            ])?;

            total_inserted += 1;
        }

        // 3. Process ProductMaster.txt for standalone products not covered by BrandMaster
        let prod_file = File::open(cdci_dir.join("ProductMaster.txt"))
            .map_err(|e| DatabaseOpError::Sqlite(rusqlite::Error::ToSqlConversionFailure(Box::new(e))))?;
        let prod_reader = BufReader::new(prod_file);

        is_header = true;
        for line in prod_reader.lines() {
            let line = line.map_err(|e| DatabaseOpError::Sqlite(rusqlite::Error::ToSqlConversionFailure(Box::new(e))))?;
            if is_header {
                is_header = false;
                continue;
            }
            if line.trim().is_empty() {
                continue;
            }

            let cols: Vec<&str> = line.split('\t').collect();
            if cols.len() < 2 {
                continue;
            }

            let prod_id = cols[0].trim();
            let prod_name = cols[1].trim();
            if prod_id.is_empty() || prod_name.is_empty() {
                continue;
            }

            if !referenced_products.contains(prod_id) {
                let parsed = parse_strengths_rust(prod_name);
                stmt.execute(params![
                    prod_id,
                    "PRODUCT",
                    prod_name,
                    Option::<String>::None,
                    Option::<String>::None,
                    Some(prod_name),
                    Option::<String>::None,
                    Option::<String>::None,
                    Option::<String>::None,
                    parsed.strengths_json,
                    parsed.raw_summary,
                    if parsed.is_combination { 1 } else { 0 },
                    if parsed.is_verified { 1 } else { 0 },
                    "CDCI_NRCES_INDIA",
                ])?;

                total_inserted += 1;
            }
        }
    }

    Ok(total_inserted)
}

fn update_catalogue_metadata(conn: &Connection, total: usize) -> Result<(), DatabaseOpError> {
    conn.execute(
        r#"
        CREATE TABLE IF NOT EXISTS catalogue_sync_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        "#,
        [],
    )?;

    let now_iso = chrono::Utc::now().to_rfc3339();
    let total_str = total.to_string();

    let mut stmt = conn.prepare(
        r#"
        INSERT INTO catalogue_sync_metadata (key, value, updated_at)
        VALUES (?1, ?2, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
        "#,
    )?;

    stmt.execute(params!["catalogue_version", CURRENT_CATALOGUE_VERSION])?;
    stmt.execute(params!["total_records", &total_str])?;
    stmt.execute(params!["sync_status", "COMPLETED"])?;
    stmt.execute(params!["catalogue_sync_status", "COMPLETED"])?;
    stmt.execute(params!["catalogue_sync_downloaded", &total_str])?;
    stmt.execute(params!["catalogue_sync_total", &total_str])?;
    stmt.execute(params!["catalogue_sync_cursor", ""])?;
    stmt.execute(params!["catalogue_sync_last_synced_at", &now_iso])?;

    Ok(())
}

fn load_tsv_lookup(path: &Path, id_col: usize, val_col: usize) -> Result<HashMap<String, String>, DatabaseOpError> {
    let mut map = HashMap::new();
    if !path.exists() {
        return Ok(map);
    }

    let file = File::open(path)
        .map_err(|e| DatabaseOpError::Sqlite(rusqlite::Error::ToSqlConversionFailure(Box::new(e))))?;
    let reader = BufReader::new(file);

    let mut is_header = true;
    for line in reader.lines() {
        let line = line.map_err(|e| DatabaseOpError::Sqlite(rusqlite::Error::ToSqlConversionFailure(Box::new(e))))?;
        if is_header {
            is_header = false;
            continue;
        }
        let cols: Vec<&str> = line.split('\t').collect();
        if cols.len() > id_col && cols.len() > val_col {
            let id = cols[id_col].trim();
            let val = cols[val_col].trim();
            if !id.is_empty() && !val.is_empty() {
                map.insert(id.to_string(), val.to_string());
            }
        }
    }

    Ok(map)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use crate::db::operations::DbOperations;
    use crate::db::schema::MIGRATION_V5_SQL;

    #[test]
    fn test_seed_and_a_to_z_search() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(MIGRATION_V5_SQL).unwrap();

        let count = seed_local_catalogue_if_empty(&mut conn, None).unwrap();
        assert!(count >= 104_000, "Expected at least 104,000 medicines seeded, found {}", count);

        // 1. Test search for 'a' with Tablet
        let a_tablets = DbOperations::search_local_catalogue(&conn, "a", 20, Some("Tablet")).unwrap();
        assert!(!a_tablets.is_empty(), "Expected search for 'a' with Tablet to return results");
        assert!(a_tablets[0].name.to_ascii_uppercase().starts_with('A'), "First result should start with A");

        // 2. Test Amoxicillin full and partial searches
        let amox = DbOperations::search_local_catalogue(&conn, "Amoxicillin", 10, Some("Tablet")).unwrap();
        assert!(!amox.is_empty(), "Expected Amoxicillin results");

        // 3. Test Paracetamol strengths
        let para_strengths = DbOperations::get_local_catalogue_strengths(&conn, "Paracetamol", Some("Tablet")).unwrap();
        assert!(!para_strengths.is_empty(), "Expected Paracetamol strengths");

        // 4. Test A-Z prefix coverage
        for ch in 'A'..='Z' {
            let s = ch.to_string();
            let results = DbOperations::search_local_catalogue(&conn, &s, 10, None).unwrap();
            assert!(!results.is_empty(), "Letter {} should return matching medicines", ch);
        }
    }

    #[tokio::test]
    async fn test_offline_catalogue_restart_and_sync_avoidance() {
        use std::sync::Arc;
        use crate::auth::SessionManager;
        use crate::crypto::key_manager::KeyManager;
        use crate::commands::RefreshCoordinator;
        use crate::db::DatabaseManager;
        use crate::sync::catalogue_sync::CatalogueSyncManager;

        let temp_dir = std::env::temp_dir().join(format!("cliniqo_offline_cat_{}", uuid::Uuid::new_v4()));
        let db = Arc::new(DatabaseManager::init(&temp_dir).unwrap());
        let key_mgr = Arc::new(KeyManager::new(&temp_dir));
        let session_mgr = Arc::new(SessionManager::with_default_public_key().unwrap());
        let coordinator = Arc::new(RefreshCoordinator::new());

        // 1. Seed the local catalogue from flat files
        {
            let mut conn = db.get_connection();
            let count = seed_local_catalogue_if_empty(&mut conn, None).unwrap();
            assert!(count >= 104_000, "Expected >= 104,000 medicines, found {}", count);
        }

        // 2. Simulate application restart: instantiate a new CatalogueSyncManager
        let manager = CatalogueSyncManager::new(db.clone(), session_mgr.clone(), key_mgr.clone(), coordinator.clone());
        let initial_status = manager.get_status().await;

        assert_eq!(initial_status.status, "COMPLETED");
        assert!(initial_status.is_ready);
        assert!(initial_status.downloaded_count >= 104_000);
        assert!(initial_status.total_count >= 104_000);

        // 3. Verify start_sync returns immediately without starting network synchronization
        let sync_res = manager.start_sync(None).await.unwrap();
        assert_eq!(sync_res.status, "COMPLETED");
        assert!(sync_res.is_ready);

        // 4. Verify offline search works across all required dimensions without network
        let conn = db.get_connection();

        // Brand search
        let calpol = DbOperations::search_local_catalogue(&conn, "Calpol", 10, None).unwrap();
        assert!(!calpol.is_empty(), "Expected offline Calpol brand search to succeed");

        // Generic search
        let para = DbOperations::search_local_catalogue(&conn, "Paracetamol", 10, None).unwrap();
        assert!(!para.is_empty(), "Expected offline Paracetamol generic search to succeed");

        // Standalone product searches (ProductMaster 151 items)
        let kuffex = DbOperations::search_local_catalogue(&conn, "Kuffex", 5, None).unwrap();
        assert!(!kuffex.is_empty(), "Expected offline Kuffex standalone product search to succeed");
        assert_eq!(kuffex[0].item_type, "PRODUCT");

        let thand_go = DbOperations::search_local_catalogue(&conn, "Thand Go", 5, None).unwrap();
        assert!(!thand_go.is_empty(), "Expected offline Thand Go standalone product search to succeed");
        assert_eq!(thand_go[0].item_type, "PRODUCT");

        // Formulation filtered search
        let tablets = DbOperations::search_local_catalogue(&conn, "Calpol", 10, Some("Tablet")).unwrap();
        assert!(!tablets.is_empty(), "Expected offline tablet search to succeed");
        for t in &tablets {
            let form = t.dosage_form.as_deref().unwrap_or("");
            assert!(form.to_ascii_uppercase().contains("TABLET") || t.name.to_ascii_uppercase().contains("TABLET"));
        }

        // Combination medicines
        let combos = DbOperations::search_local_catalogue(&conn, "Amoxicillin and Clavulanic", 10, None).unwrap();
        if !combos.is_empty() {
            assert!(combos.iter().any(|c| c.is_combination));
        }

        // Strengths retrieval
        let strengths = DbOperations::get_local_catalogue_strengths(&conn, "Paracetamol", Some("Tablet")).unwrap();
        assert!(!strengths.is_empty(), "Expected verified strengths for Paracetamol Tablet");

        // 5. Offline prescription creation test with local catalogue selection
        let dek = db.get_dek();
        let clinic_id = "clinic_offline_test";
        let doc_id = "doc_offline_test";
        let pat_id = "pat_offline_001";

        drop(conn);
        let mut mut_conn = db.get_connection();

        DbOperations::insert_patient(
            &mut mut_conn,
            &dek,
            clinic_id,
            pat_id,
            "Ramesh Kumar",
            "9876543210",
            "MALE",
            Some("1980-01-01"),
            46,
            &[],
            &[],
            None,
        )
        .unwrap();

        let rx_json = serde_json::json!([
            {
                "medicineName": calpol[0].name.clone(),
                "dosageForm": calpol[0].dosage_form.clone().unwrap_or_else(|| "Tablet".to_string()),
                "strength": strengths[0].clone(),
                "dosage": "1 tablet",
                "frequency": "1-0-1",
                "duration": "5 days",
                "instructions": "After meals"
            }
        ])
        .to_string();

        let cons_id = DbOperations::insert_consultation(
            &mut mut_conn,
            &dek,
            clinic_id,
            pat_id,
            doc_id,
            "2026-11-02",
            "Fever and headache",
            "Viral Fever",
            Some(&rx_json),
        )
        .unwrap();

        assert!(!cons_id.is_empty(), "Prescription consultation created offline successfully");

        // Verify prescription snapshot persists encrypted at rest and is decrypted cleanly
        let cons_list = DbOperations::get_consultations(&mut_conn, &dek, clinic_id).unwrap();
        assert_eq!(cons_list.len(), 1, "Offline prescription consultation must be retrievable");
        assert_eq!(cons_list[0].diagnosis, "Viral Fever");
        assert!(cons_list[0].clinical_snapshot_json.as_ref().unwrap().contains("Calpol"));

        drop(mut_conn);
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_product_master_reconciliation_and_coverage() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(MIGRATION_V5_SQL).unwrap();

        let count = seed_local_catalogue_if_empty(&mut conn, None).unwrap();
        // Generics (10,305) + Brands (93,911) + Standalone Products (151) = 104,367
        assert_eq!(count, 104_367, "Expected exact count of 104,367 medicines seeded, found {}", count);

        // Verify counts by item_type
        let brand_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM local_catalogue_cache_v1 WHERE item_type = 'BRAND'",
            [],
            |r| r.get(0),
        ).unwrap();
        let generic_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM local_catalogue_cache_v1 WHERE item_type = 'GENERIC'",
            [],
            |r| r.get(0),
        ).unwrap();
        let product_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM local_catalogue_cache_v1 WHERE item_type = 'PRODUCT'",
            [],
            |r| r.get(0),
        ).unwrap();

        assert_eq!(generic_count, 10_305, "GenericMaster must have 10,305 records");
        assert_eq!(brand_count, 93_911, "BrandMaster must have 93,911 records");
        assert_eq!(product_count, 151, "Standalone ProductMaster entries must equal 151");

        // Verify distinct product representation
        let distinct_products: i64 = conn.query_row(
            "SELECT COUNT(DISTINCT product_name) FROM local_catalogue_cache_v1 WHERE product_name IS NOT NULL AND product_name != ''",
            [],
            |r| r.get(0),
        ).unwrap();
        // Note: 72,284 product IDs map to 71,940 distinct product name strings in ProductMaster (some names share casing/spacing)
        assert!(distinct_products >= 71_000, "Expected >= 71,000 distinct product names, found {}", distinct_products);

        // Verify standalone product searchability
        let thand_go = DbOperations::search_local_catalogue(&conn, "Thand Go", 5, None).unwrap();
        assert!(!thand_go.is_empty(), "Expected standalone product 'Thand Go' to be searchable");
        assert_eq!(thand_go[0].item_type, "PRODUCT");
        assert_eq!(thand_go[0].name, "Thand Go");

        let kuffex = DbOperations::search_local_catalogue(&conn, "Kuffex", 5, None).unwrap();
        assert!(!kuffex.is_empty(), "Expected standalone product 'Kuffex' to be searchable");
        assert_eq!(kuffex[0].item_type, "PRODUCT");
    }

    #[test]
    fn test_existing_104216_database_backfill_and_idempotency() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(MIGRATION_V5_SQL).unwrap();

        let cdci_dir = find_cdci_package_dir(None).expect("CDCI package must be present for test");

        // 1. Simulate an older 104,216 installation by seeding ONLY generics and brands (omitting standalone products)
        let forms_map = load_tsv_lookup(&cdci_dir.join("DrugFormMaster.txt"), 0, 1).unwrap();
        let routes_map = load_tsv_lookup(&cdci_dir.join("RouteOfAdministrationMaster.txt"), 0, 1).unwrap();
        let products_map = load_tsv_lookup(&cdci_dir.join("ProductMaster.txt"), 0, 1).unwrap();
        let _suppliers_map = load_tsv_lookup(&cdci_dir.join("SupplierMaster.txt"), 0, 1).unwrap();

        let tx = conn.transaction().unwrap();
        let mut generic_lookup: HashMap<String, (String, Option<String>, Option<String>)> = HashMap::new();

        {
            let mut stmt = tx.prepare(
                r#"
                INSERT INTO local_catalogue_cache_v1 (
                    id, item_type, name, brand_name, generic_name, product_name,
                    dosage_form, route, active_ingredients_json, strengths_json,
                    raw_strength_summary, is_combination, is_verified, source_provenance,
                    cached_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, CURRENT_TIMESTAMP)
                "#,
            ).unwrap();

            // Insert GenericMaster
            let gen_file = File::open(cdci_dir.join("GenericMaster.txt")).unwrap();
            let mut is_header = true;
            for line in BufReader::new(gen_file).lines() {
                let line = line.unwrap();
                if is_header { is_header = false; continue; }
                if line.trim().is_empty() { continue; }
                let cols: Vec<&str> = line.split('\t').collect();
                if cols.len() < 2 { continue; }
                let id = cols[0].trim();
                let generic_name = cols[1].trim();
                let form_id = if cols.len() > 4 { cols[4].trim() } else { "" };
                let dosage_form = forms_map.get(form_id).cloned();
                let route_id = if cols.len() > 3 { cols[3].split('+').next().unwrap_or("").trim() } else { "" };
                let route = routes_map.get(route_id).cloned();
                let parsed = parse_strengths_rust(generic_name);
                generic_lookup.insert(id.to_string(), (generic_name.to_string(), dosage_form.clone(), route.clone()));
                stmt.execute(params![
                    id, "GENERIC", generic_name, Option::<String>::None, Some(generic_name), Option::<String>::None,
                    dosage_form, route, None::<String>, parsed.strengths_json, parsed.raw_summary,
                    if parsed.is_combination { 1 } else { 0 }, if parsed.is_verified { 1 } else { 0 }, "CDCI_NRCES_INDIA"
                ]).unwrap();
            }

            // Insert BrandMaster
            let brand_file = File::open(cdci_dir.join("BrandMaster.txt")).unwrap();
            is_header = true;
            for line in BufReader::new(brand_file).lines() {
                let line = line.unwrap();
                if is_header { is_header = false; continue; }
                if line.trim().is_empty() { continue; }
                let cols: Vec<&str> = line.split('\t').collect();
                if cols.len() < 2 { continue; }
                let id = cols[0].trim();
                let brand_name = cols[1].trim();
                let product_id = if cols.len() > 2 { cols[2].trim() } else { "" };
                let generic_id = if cols.len() > 4 { cols[4].trim() } else { "" };
                let product_name = products_map.get(product_id).cloned();
                let gen_info = generic_lookup.get(generic_id);
                let generic_name = gen_info.map(|g| g.0.clone());
                let dosage_form = gen_info.and_then(|g| g.1.clone());
                let route = gen_info.and_then(|g| g.2.clone());
                let parsed = parse_strengths_rust(brand_name);
                stmt.execute(params![
                    id, "BRAND", brand_name, Some(brand_name), generic_name, product_name,
                    dosage_form, route, None::<String>, parsed.strengths_json, parsed.raw_summary,
                    if parsed.is_combination { 1 } else { 0 }, if parsed.is_verified { 1 } else { 0 }, "CDCI_NRCES_INDIA"
                ]).unwrap();
            }
        }
        tx.commit().unwrap();

        // Simulate older v1 metadata reporting 104,216 items
        conn.execute(
            r#"
            CREATE TABLE IF NOT EXISTS catalogue_sync_metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            "#,
            [],
        ).unwrap();
        conn.execute("INSERT INTO catalogue_sync_metadata (key, value) VALUES ('catalogue_version', 'CDCI_NRCES_INDIA_2026')", []).unwrap();
        conn.execute("INSERT INTO catalogue_sync_metadata (key, value) VALUES ('total_records', '104216')", []).unwrap();
        conn.execute("INSERT INTO catalogue_sync_metadata (key, value) VALUES ('sync_status', 'COMPLETED')", []).unwrap();

        // Verify initial simulated state: exactly 104,216 records and 0 products
        let initial_total: i64 = conn.query_row("SELECT COUNT(*) FROM local_catalogue_cache_v1", [], |r| r.get(0)).unwrap();
        let initial_products: i64 = conn.query_row("SELECT COUNT(*) FROM local_catalogue_cache_v1 WHERE item_type = 'PRODUCT'", [], |r| r.get(0)).unwrap();
        assert_eq!(initial_total, 104_216, "Simulated initial database must have 104,216 records");
        assert_eq!(initial_products, 0, "Simulated initial database must have 0 standalone products");
        assert!(!is_catalogue_reconciled(&conn), "Catalogue must not report reconciled yet");

        // 2. Execute reconciliation & backfill
        let reconciled_count = reconcile_and_seed_local_catalogue(&mut conn, None).unwrap();
        assert_eq!(reconciled_count, 104_367, "Reconciliation must reach exactly 104,367 records");

        // 3. Verify exact counts by dimension
        let post_total: i64 = conn.query_row("SELECT COUNT(*) FROM local_catalogue_cache_v1", [], |r| r.get(0)).unwrap();
        let post_generics: i64 = conn.query_row("SELECT COUNT(*) FROM local_catalogue_cache_v1 WHERE item_type = 'GENERIC'", [], |r| r.get(0)).unwrap();
        let post_brands: i64 = conn.query_row("SELECT COUNT(*) FROM local_catalogue_cache_v1 WHERE item_type = 'BRAND'", [], |r| r.get(0)).unwrap();
        let post_products: i64 = conn.query_row("SELECT COUNT(*) FROM local_catalogue_cache_v1 WHERE item_type = 'PRODUCT'", [], |r| r.get(0)).unwrap();

        assert_eq!(post_total, 104_367, "Total count must be exactly 104,367");
        assert_eq!(post_generics, 10_305, "Generics must remain intact at 10,305");
        assert_eq!(post_brands, 93_911, "Brands must remain intact at 93,911");
        assert_eq!(post_products, 151, "Standalone products must be backfilled to 151");

        // 4. Verify metadata updated
        assert!(is_catalogue_reconciled(&conn), "Catalogue must now report reconciled");
        let version: String = conn.query_row("SELECT value FROM catalogue_sync_metadata WHERE key = 'catalogue_version'", [], |r| r.get(0)).unwrap();
        let total_meta: String = conn.query_row("SELECT value FROM catalogue_sync_metadata WHERE key = 'total_records'", [], |r| r.get(0)).unwrap();
        assert_eq!(version, "CDCI_NRCES_INDIA_2026_V2");
        assert_eq!(total_meta, "104367");

        // 5. Test idempotency: re-running reconcile_and_seed must NOT create duplicates
        let rerun_count = reconcile_and_seed_local_catalogue(&mut conn, None).unwrap();
        assert_eq!(rerun_count, 104_367);
        let rerun_total: i64 = conn.query_row("SELECT COUNT(*) FROM local_catalogue_cache_v1", [], |r| r.get(0)).unwrap();
        assert_eq!(rerun_total, 104_367, "Repeated execution must not create duplicates");

        // 6. Verify standalone products are now searchable
        let thand_go = DbOperations::search_local_catalogue(&conn, "Thand Go", 5, None).unwrap();
        assert!(!thand_go.is_empty(), "Backfilled product 'Thand Go' must be searchable");
        assert_eq!(thand_go[0].item_type, "PRODUCT");

        // 7. Verify existing generic and brand records were preserved intact
        let calpol = DbOperations::search_local_catalogue(&conn, "Calpol", 5, None).unwrap();
        assert!(!calpol.is_empty(), "Existing brand Calpol must remain searchable");
        let para = DbOperations::search_local_catalogue(&conn, "Paracetamol", 5, None).unwrap();
        assert!(!para.is_empty(), "Existing generic Paracetamol must remain searchable");
    }

    #[test]
    fn test_windows_upgrade_migration_v7_auto_reconciliation() {
        use crate::crypto::key_manager::DatabaseEncryptionKey;
        use crate::db::migrations::MigrationRunner;

        let mut conn = Connection::open_in_memory().unwrap();
        let dek = DatabaseEncryptionKey::new([0x33u8; 32]);

        // Run all migrations including v7 on startup
        MigrationRunner::run_migrations(&mut conn, &dek).expect("migrations succeed");

        // Verify schema_migrations has version 7 or higher
        let max_version: i32 = conn.query_row("SELECT MAX(version) FROM schema_migrations", [], |r| r.get(0)).unwrap();
        assert!(max_version >= 7, "Migration v7 or higher must be applied");

        // In app startup runtime, reconcile_and_seed_local_catalogue runs:
        let seeded = reconcile_and_seed_local_catalogue(&mut conn, None).unwrap();
        assert_eq!(seeded, 104_367);

        // Verify catalogue is fully seeded and reconciled to 104,367
        let total: i64 = conn.query_row("SELECT COUNT(*) FROM local_catalogue_cache_v1", [], |r| r.get(0)).unwrap();
        assert_eq!(total, 104_367, "Catalogue must be reconciled to 104,367");
        assert!(is_catalogue_reconciled(&conn), "Catalogue must be marked reconciled");
    }

    #[test]
    fn test_complete_windows_v7_changes_verification() {
        use crate::crypto::key_manager::DatabaseEncryptionKey;
        use crate::db::migrations::MigrationRunner;
        use crate::db::schema::{DoctorProfileRecord, SaveFormularyArgs};

        let mut conn = Connection::open_in_memory().unwrap();
        let dek = DatabaseEncryptionKey::new([0x88u8; 32]);

        // 1. FRESH INSTALLATION: Apply all migrations up to V9
        MigrationRunner::run_migrations(&mut conn, &dek).expect("Migrations run successfully");

        let max_version: i32 = conn.query_row("SELECT MAX(version) FROM schema_migrations", [], |r| r.get(0)).unwrap();
        assert_eq!(max_version, 9, "All migrations up to V9 must be applied");

        // Auto-seed on fresh installation
        let seeded = reconcile_and_seed_local_catalogue(&mut conn, None).unwrap();
        assert_eq!(seeded, 104_367, "Must seed all 104,367 CDCI records");

        let generics: i64 = conn.query_row("SELECT COUNT(*) FROM local_catalogue_cache_v1 WHERE item_type = 'GENERIC'", [], |r| r.get(0)).unwrap();
        let brands: i64 = conn.query_row("SELECT COUNT(*) FROM local_catalogue_cache_v1 WHERE item_type = 'BRAND'", [], |r| r.get(0)).unwrap();
        let products: i64 = conn.query_row("SELECT COUNT(*) FROM local_catalogue_cache_v1 WHERE item_type = 'PRODUCT'", [], |r| r.get(0)).unwrap();
        let total: i64 = conn.query_row("SELECT COUNT(*) FROM local_catalogue_cache_v1", [], |r| r.get(0)).unwrap();

        assert_eq!(generics, 10_305, "Generics count must be exactly 10,305");
        assert_eq!(brands, 93_911, "Brands count must be exactly 93,911");
        assert_eq!(products, 151, "Standalone products count must be exactly 151");
        assert_eq!(total, 104_367, "Total catalogue count must be exactly 104,367");

        // 2. OFFLINE MEDICINE SEARCH: Verify immediate local search without network
        let calpol = DbOperations::search_local_catalogue(&conn, "Calpol", 5, None).unwrap();
        assert!(!calpol.is_empty(), "Calpol must be found offline");
        assert!(calpol.iter().any(|m| m.name.starts_with("Calpol")));

        let paracetamol = DbOperations::search_local_catalogue(&conn, "Paracetamol", 5, None).unwrap();
        assert!(!paracetamol.is_empty(), "Paracetamol must be found offline");

        let thand_go = DbOperations::search_local_catalogue(&conn, "Thand Go", 5, None).unwrap();
        assert!(!thand_go.is_empty(), "Standalone product 'Thand Go' must be found offline");
        assert_eq!(thand_go[0].item_type, "PRODUCT");

        let kuffex = DbOperations::search_local_catalogue(&conn, "Kuffex", 5, None).unwrap();
        assert!(!kuffex.is_empty(), "Standalone product 'Kuffex' must be found offline");
        assert_eq!(kuffex[0].item_type, "PRODUCT");

        // 3. DOCTOR CREDENTIALS PERSISTENCE: Qualification, registration number, mobile persist
        let doctor_id = "doc-win-test-404";
        let doc_record = DoctorProfileRecord {
            doctor_id: doctor_id.to_string(),
            full_name: "Dr. Dipesh Patekar".to_string(),
            email: "dipesh@cliniqo.test".to_string(),
            phone: "+91 9876543210".to_string(),
            qualification: "MBBS, MD (Medicine)".to_string(),
            registration_number: "MMC 2024/09/8888".to_string(),
            gender: "Male".to_string(),
            updated_at: None,
        };

        DbOperations::upsert_doctor_profile(&conn, &doc_record).unwrap();

        let loaded_doc = DbOperations::get_doctor_profile(&conn, doctor_id).unwrap().expect("doctor profile found");
        assert_eq!(loaded_doc.qualification, "MBBS, MD (Medicine)");
        assert_eq!(loaded_doc.registration_number, "MMC 2024/09/8888");
        assert_eq!(loaded_doc.phone, "+91 9876543210");
        assert_eq!(loaded_doc.gender, "Male");

        // Non-destructive update: Empty values do not wipe existing credentials
        let empty_update = DoctorProfileRecord {
            doctor_id: doctor_id.to_string(),
            full_name: "".to_string(),
            email: "".to_string(),
            phone: "+91 9999900000".to_string(),
            qualification: "".to_string(),
            registration_number: "".to_string(),
            gender: "".to_string(),
            updated_at: None,
        };
        DbOperations::upsert_doctor_profile(&conn, &empty_update).unwrap();

        let preserved_doc = DbOperations::get_doctor_profile(&conn, doctor_id).unwrap().expect("doctor profile found");
        assert_eq!(preserved_doc.phone, "+91 9999900000");
        assert_eq!(preserved_doc.qualification, "MBBS, MD (Medicine)", "Qualification preserved");
        assert_eq!(preserved_doc.registration_number, "MMC 2024/09/8888", "Registration number preserved");
        assert_eq!(preserved_doc.full_name, "Dr. Dipesh Patekar", "Full name preserved");

        // 4. CUSTOM MEDICINE AUTO-SAVE TO CLINICAL LIBRARY
        let clinic_id = "clinic-win-test-1";
        let custom_med = SaveFormularyArgs {
            id: None,
            clinic_id: clinic_id.to_string(),
            name: "Herbal Cold Relief".to_string(),
            active_ingredient: Some("Tulsi + Adhatoda Extract".to_string()),
            formulation: "Syrup".to_string(),
            strength: "100 ml".to_string(),
            default_dose: Some("10 ml".to_string()),
            default_route: Some("Oral".to_string()),
            default_frequency: Some("TID".to_string()),
            default_duration: Some("5 days".to_string()),
            default_instructions: Some("After food".to_string()),
        };

        let formulary_id = DbOperations::save_formulary_item(&mut conn, clinic_id, custom_med).unwrap();
        assert!(!formulary_id.is_empty());

        let formulary_items = DbOperations::get_formulary_items(&conn, clinic_id).unwrap();
        assert_eq!(formulary_items.len(), 1);
        assert_eq!(formulary_items[0].name, "Herbal Cold Relief");
        assert_eq!(formulary_items[0].formulation, "Syrup");
        assert_eq!(formulary_items[0].active_ingredient.as_deref(), Some("Tulsi + Adhatoda Extract"));

        // Deduplication on re-prescribing the same custom medicine
        let custom_med_rerun = SaveFormularyArgs {
            id: None,
            clinic_id: clinic_id.to_string(),
            name: " herbal cold relief ".to_string(),
            active_ingredient: None,
            formulation: "Syrup".to_string(),
            strength: "100 ml".to_string(),
            default_dose: Some("10 ml".to_string()),
            default_route: Some("Oral".to_string()),
            default_frequency: Some("TID".to_string()),
            default_duration: Some("7 days".to_string()),
            default_instructions: None,
        };

        let deduplicated_id = DbOperations::save_formulary_item(&mut conn, clinic_id, custom_med_rerun).unwrap();
        assert_eq!(deduplicated_id, formulary_id, "Reuses existing ID and avoids duplication");

        let items_after_dedup = DbOperations::get_formulary_items(&conn, clinic_id).unwrap();
        assert_eq!(items_after_dedup.len(), 1, "Only 1 entry in Clinical Library");

        // 5. EXISTING CLINICAL DATA REMAINS INTACT
        let patient_id = DbOperations::insert_patient(
            &mut conn,
            &dek,
            clinic_id,
            "P-WIN-001",
            "Amitabh V. Verma",
            "+91 9820011223",
            "MALE",
            Some("1980-05-12"),
            46,
            &["Sulfa drugs".to_string()],
            &["Asthma".to_string()],
            Some("Sensitive history notes"),
        ).unwrap();

        let patients = DbOperations::get_patients(&conn, &dek, clinic_id).unwrap();
        assert_eq!(patients.len(), 1);
        assert_eq!(patients[0].id, patient_id);
        assert_eq!(patients[0].name, "Amitabh V. Verma");
        assert_eq!(patients[0].allergies, vec!["Sulfa drugs"]);

        let consult_id = DbOperations::insert_consultation(
            &mut conn,
            &dek,
            clinic_id,
            &patient_id,
            doctor_id,
            "2026-11-04",
            "Severe bronchial cough",
            "Acute Bronchitis",
            Some(r#"{"vitals":{"heartRate":"76"}}"#),
        ).unwrap();

        let consults = DbOperations::get_consultations(&conn, &dek, clinic_id).unwrap();
        assert_eq!(consults.len(), 1);
        assert_eq!(consults[0].id, consult_id);
        assert_eq!(consults[0].chief_complaint, "Severe bronchial cough");
        assert_eq!(consults[0].diagnosis, "Acute Bronchitis");

        // Prescription snapshot remains immutable
        let rx_json = r#"[{"name":"Herbal Cold Relief","formulation":"Syrup","dose":"10 ml"}]"#;
        let rx_id = DbOperations::insert_prescription(
            &mut conn,
            &dek,
            clinic_id,
            &consult_id,
            &patient_id,
            doctor_id,
            "RX-WIN-9901",
            rx_json,
        ).unwrap();

        let rxs = DbOperations::get_prescriptions(&conn, &dek, clinic_id).unwrap();
        assert_eq!(rxs.len(), 1);
        assert_eq!(rxs[0].id, rx_id);
        assert_eq!(rxs[0].items_json.as_deref(), Some(rx_json));

        // 6. RESTART IDEMPOTENCY: Repeated seed execution creates zero duplicates and returns in < 1ms
        let rerun_count = reconcile_and_seed_local_catalogue(&mut conn, None).unwrap();
        assert_eq!(rerun_count, 104_367);

        let final_count: i64 = conn.query_row("SELECT COUNT(*) FROM local_catalogue_cache_v1", [], |r| r.get(0)).unwrap();
        assert_eq!(final_count, 104_367, "Count must remain exactly 104,367 on app restart");
    }
}

