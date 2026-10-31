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
                parent.join("CommonDrugCodesForIndia_FlatFilePackage"),
                parent.join("data").join("cdci").join("CommonDrugCodesForIndia_FlatFilePackage"),
                parent.join("resources").join("CommonDrugCodesForIndia_FlatFilePackage"),
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

/// Automatically seeds `local_catalogue_cache_v1` in SQLite if it is currently empty.
/// Runs inside a single high-performance SQLite transaction.
pub fn seed_local_catalogue_if_empty(
    conn: &mut Connection,
    custom_dir: Option<&Path>,
) -> Result<usize, DatabaseOpError> {
    let existing_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM local_catalogue_cache_v1",
        [],
        |r| r.get(0),
    )?;

    if existing_count > 0 {
        return Ok(existing_count as usize);
    }

    let cdci_dir = match find_cdci_package_dir(custom_dir) {
        Some(dir) => dir,
        None => {
            log::warn!("CDCI flat file package not found. Skipping offline catalogue seed.");
            return Ok(0);
        }
    };

    log::info!("Seeding local offline CDCI catalogue from {:?}", cdci_dir);

    // 1. Load auxiliary lookups
    let forms_map = load_tsv_lookup(&cdci_dir.join("DrugFormMaster.txt"), 0, 1)?;
    let routes_map = load_tsv_lookup(&cdci_dir.join("RouteOfAdministrationMaster.txt"), 0, 1)?;
    let products_map = load_tsv_lookup(&cdci_dir.join("ProductMaster.txt"), 0, 1)?;
    let suppliers_map = load_tsv_lookup(&cdci_dir.join("SupplierMaster.txt"), 0, 1)?;

    let tx = conn.transaction()?;
    let mut total_inserted = 0;

    let mut generic_lookup: HashMap<String, (String, Option<String>, Option<String>)> =
        HashMap::new();

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

        // 2. Process GenericMaster.txt
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

        // 3. Process BrandMaster.txt
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
    }

    // 4. Update sync metadata
    tx.execute(
        r#"
        CREATE TABLE IF NOT EXISTS catalogue_sync_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        "#,
        [],
    )?;

    tx.execute(
        r#"
        INSERT INTO catalogue_sync_metadata (key, value, updated_at)
        VALUES ('catalogue_version', 'CDCI_NRCES_INDIA_2026', CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
        "#,
        [],
    )?;

    tx.execute(
        r#"
        INSERT INTO catalogue_sync_metadata (key, value, updated_at)
        VALUES ('total_records', ?1, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
        "#,
        params![total_inserted.to_string()],
    )?;

    tx.execute(
        r#"
        INSERT INTO catalogue_sync_metadata (key, value, updated_at)
        VALUES ('sync_status', 'SEEDED', CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
        "#,
        [],
    )?;

    tx.commit()?;
    log::info!(
        "Successfully seeded local SQLite catalogue with {} total medicines.",
        total_inserted
    );

    Ok(total_inserted)
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
}

