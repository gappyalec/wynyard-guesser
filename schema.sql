-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query)

-- Rounds table: stores each location photo and its correct answer
CREATE TABLE IF NOT EXISTS rounds (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  photo_url TEXT NOT NULL,
  answer_lat DOUBLE PRECISION NOT NULL,
  answer_lng DOUBLE PRECISION NOT NULL,
  label TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Game scores: saved at end of each game
CREATE TABLE IF NOT EXISTS game_scores (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  room_code TEXT NOT NULL,
  player_name TEXT NOT NULL,
  score INTEGER NOT NULL,
  rank INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable Row Level Security but allow all for now (you control via service key)
ALTER TABLE rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_scores ENABLE ROW LEVEL SECURITY;

-- Allow service role full access (backend uses service key)
CREATE POLICY "Service role access" ON rounds FOR ALL USING (true);
CREATE POLICY "Service role access" ON game_scores FOR ALL USING (true);
