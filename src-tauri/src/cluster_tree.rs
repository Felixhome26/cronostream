//! Backend twin of `src/utils/clusterTree.ts`'s `buildClusterTree` —
//! identical algorithm, including the "ties go to the gap nearest the
//! middle" rule (see that file's own doc comment for why: it's what keeps
//! an evenly-spaced run of items from degenerating into one-at-a-time
//! splits). Moved here rather than fixed in place because a Web Worker
//! turned out not to give this app's WebKitGTK webview the real off-main-
//! thread concurrency it promises (measured: a main-thread heartbeat timer
//! went completely silent for the worker's whole multi-second run) —
//! `spawn_blocking` on a real OS thread does.

use std::collections::HashMap;

use serde::Serialize;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ClusterNode {
    lo: usize,
    hi: usize,
    span_ms: i64,
    max_gap_ms: i64,
    left: Option<Box<ClusterNode>>,
    right: Option<Box<ClusterNode>>,
}

/// Builds the tree for one lane from its chronologically sorted timestamps.
/// `None` for an empty lane — see `clusterTree.ts`'s own doc comment for the
/// full reasoning behind the shape and the tie-break rule.
pub fn build_cluster_tree(times_ms: &[i64]) -> Option<ClusterNode> {
    if times_ms.is_empty() {
        return None;
    }
    Some(node(times_ms, 0, times_ms.len() - 1))
}

fn node(times_ms: &[i64], lo: usize, hi: usize) -> ClusterNode {
    if lo == hi {
        return ClusterNode { lo, hi, span_ms: 0, max_gap_ms: 0, left: None, right: None };
    }
    let middle = (lo as f64 + hi as f64) / 2.0;
    let mut split_at = lo;
    let mut largest_gap: i64 = -1;
    for i in lo..hi {
        let gap = times_ms[i + 1] - times_ms[i];
        if gap > largest_gap || (gap == largest_gap && (i as f64 - middle).abs() < (split_at as f64 - middle).abs()) {
            largest_gap = gap;
            split_at = i;
        }
    }
    ClusterNode {
        lo,
        hi,
        span_ms: times_ms[hi] - times_ms[lo],
        max_gap_ms: largest_gap,
        left: Some(Box::new(node(times_ms, lo, split_at))),
        right: Some(Box::new(node(times_ms, split_at + 1, hi))),
    }
}

/// `async` + `spawn_blocking`: stateless pure computation (no project lock
/// needed), but a large/unlucky lane can still take real time (see the
/// module doc comment) and must not sit on the IPC thread. Built fresh on
/// every call rather than cached — the frontend only calls this when its
/// own item list changed, so there is nothing to invalidate here.
#[tauri::command]
pub async fn build_cluster_trees(times_ms_by_lane: HashMap<String, Vec<i64>>) -> HashMap<String, Option<ClusterNode>> {
    tauri::async_runtime::spawn_blocking(move || {
        times_ms_by_lane.into_iter().map(|(lane, times_ms)| (lane, build_cluster_tree(&times_ms))).collect()
    })
    .await
    .unwrap_or_default()
}
