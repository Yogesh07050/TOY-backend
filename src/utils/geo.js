'use strict';

const EARTH_RADIUS_KM = 6371;

/**
 * SQL fragment computing great-circle distance in km between a branch row and
 * a customer position. Expects three bound params in order: lat, lng, lat.
 *
 * Used together with `boundingBox()` so the DB can range-scan `idx_branch_geo`
 * before doing the trigonometry (§33 - searches must run server side).
 */
function distanceKmSql(latColumn, lngColumn) {
  return `(${EARTH_RADIUS_KM} * ACOS(
    LEAST(1, GREATEST(-1,
      COS(RADIANS(?)) * COS(RADIANS(${latColumn})) * COS(RADIANS(${lngColumn}) - RADIANS(?))
      + SIN(RADIANS(?)) * SIN(RADIANS(${latColumn}))
    ))
  ))`;
}

/** Params for `distanceKmSql`, in the order the placeholders appear. */
const distanceKmParams = (lat, lng) => [lat, lng, lat];

/**
 * Latitude/longitude window that fully contains a radius around a point.
 * Longitude degrees shrink towards the poles, hence the cos() correction.
 */
function boundingBox(lat, lng, radiusKm) {
  const latDelta = radiusKm / 111.32;
  const cos = Math.cos((lat * Math.PI) / 180);
  const lngDelta = radiusKm / (111.32 * Math.max(Math.abs(cos), 0.000001));
  return {
    minLat: lat - latDelta,
    maxLat: lat + latDelta,
    minLng: lng - lngDelta,
    maxLng: lng + lngDelta,
  };
}

const isValidLatitude = (value) => Number.isFinite(value) && value >= -90 && value <= 90;
const isValidLongitude = (value) => Number.isFinite(value) && value >= -180 && value <= 180;

module.exports = {
  EARTH_RADIUS_KM,
  distanceKmSql,
  distanceKmParams,
  boundingBox,
  isValidLatitude,
  isValidLongitude,
};
