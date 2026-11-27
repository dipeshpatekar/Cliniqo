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

    // Check upwards from current_dir
    if let Ok(mut dir) = std::env::current_dir() {
        for _ in 0..6 {
            let candidate = dir.join("backend/data/cdci/CommonDrugCodesForIndia_FlatFilePackage");
            if candidate.join("GenericMaster.txt").exists() {
                return Some(candidate);
            }
            let cand2 = dir.join("data/cdci/CommonDrugCodesForIndia_FlatFilePackage");
            if cand2.join("GenericMaster.txt").exists() {
                return Some(cand2);
            }
            if !dir.pop() {
                break;
            }
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
        if let Some(mut parent) = exe.parent().map(|p| p.to_path_buf()) {
            for _ in 0..6 {
                let resource_candidates = [
                    parent.clone(),
                    parent.join("resources"),
                    parent.join("CommonDrugCodesForIndia_FlatFilePackage"),
                    parent.join("resources").join("CommonDrugCodesForIndia_FlatFilePackage"),
                    parent.join("data").join("cdci").join("CommonDrugCodesForIndia_FlatFilePackage"),
                    parent.join("backend").join("data").join("cdci").join("CommonDrugCodesForIndia_FlatFilePackage"),
                    parent.join("resources").join("backend").join("data").join("cdci").join("CommonDrugCodesForIndia_FlatFilePackage"),
                    parent.join("resources").join("_up_").join("backend").join("data").join("cdci").join("CommonDrugCodesForIndia_FlatFilePackage"),
                ];
                for rc in &resource_candidates {
                    if rc.exists() && rc.join("GenericMaster.txt").exists() {
                        return Some(rc.clone());
                    }
                }
                if !parent.pop() {
                    break;
                }
            }
        }
    }

    None
}

pub const EXPECTED_TOTAL_RECORDS: usize = 0;
pub const EXPECTED_GENERIC_RECORDS: usize = 0;
pub const EXPECTED_BRAND_RECORDS: usize = 0;
pub const EXPECTED_PRODUCT_RECORDS: usize = 0;
pub const CURRENT_CATALOGUE_VERSION: &str = "CLINICAL_LIBRARY_V1";

/// CDCI dataset removed. Catalogue is always considered reconciled.
pub fn is_catalogue_reconciled(_conn: &Connection) -> bool {
    true
}

/// CDCI dataset removed. Seeding is a clean no-op.
pub fn reconcile_and_seed_local_catalogue(
    _conn: &mut Connection,
    _custom_dir: Option<&Path>,
) -> Result<usize, DatabaseOpError> {
    Ok(0)
}

/// Backwards-compatible alias for `reconcile_and_seed_local_catalogue`.
pub fn seed_local_catalogue_if_empty(
    conn: &mut Connection,
    custom_dir: Option<&Path>,
) -> Result<usize, DatabaseOpError> {
    reconcile_and_seed_local_catalogue(conn, custom_dir)
}

#[allow(dead_code)]
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

#[allow(dead_code)]
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

#[allow(dead_code)]
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

#[allow(dead_code)]
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
    use crate::crypto::key_manager::DatabaseEncryptionKey;
    use crate::db::migrations::MigrationRunner;
    use crate::db::operations::DbOperations;
    use crate::db::schema::{DoctorProfileRecord, SaveFormularyArgs};

    #[test]
    fn test_cdci_removal_and_v11_migration() {
        let mut conn = Connection::open_in_memory().unwrap();
        let dek = DatabaseEncryptionKey::new([0x88u8; 32]);

        // Run migrations up to v11
        MigrationRunner::run_migrations(&mut conn, &dek).expect("Migrations run successfully");

        let max_version: i32 = conn.query_row("SELECT MAX(version) FROM schema_migrations", [], |r| r.get(0)).unwrap();
        assert!(max_version >= 11, "All migrations up to V11+ must be applied");

        // Confirm local_catalogue_cache_v1 table does not exist
        let table_exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_catalogue_cache_v1')",
            [],
            |r| r.get(0),
        ).unwrap();
        assert!(!table_exists, "local_catalogue_cache_v1 table must be dropped in V11");

        // Auto-seed on fresh installation is a safe no-op
        let seeded = reconcile_and_seed_local_catalogue(&mut conn, None).unwrap();
        assert_eq!(seeded, 0, "CDCI seed must return 0 records");
        assert!(is_catalogue_reconciled(&conn), "Catalogue must be marked reconciled");
    }

    #[test]
    fn test_doctor_and_clinical_operations_intact_post_cdci_removal() {
        let mut conn = Connection::open_in_memory().unwrap();
        let dek = DatabaseEncryptionKey::new([0x88u8; 32]);

        MigrationRunner::run_migrations(&mut conn, &dek).expect("Migrations run successfully");

        // 1. DOCTOR PROFILE PERSISTENCE
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

        // 2. CUSTOM MEDICINE AUTO-SAVE TO CLINICAL FORMULARY
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

        // 3. PATIENT AND CONSULTATION LIFECYCLE
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
        assert_eq!(patients[0].name, "Amitabh V. Verma");

        let _consult_id = DbOperations::insert_consultation(
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

        let consults = DbOperations::get_consultations(&conn, &dek, clinic_id, None).unwrap();
        assert_eq!(consults.len(), 1);
        assert_eq!(consults[0].diagnosis, "Acute Bronchitis");

        // 4. SEARCH WHEN NO CDCI PRESENT
        let results = DbOperations::search_local_catalogue(&conn, clinic_id, "NonExistentDrug", 5, None).unwrap();
        assert!(results.is_empty(), "Empty search cleanly handled");
    }
}
