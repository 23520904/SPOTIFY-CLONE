import { Song } from "../models/song.model.js";

export const getAllSongs = async (req, res, next) => {
  try {
    const songs = await Song.find().sort({ createdAt: -1 });
    res.json(songs);
  } catch (error) {
    next(error);
  }
};

export const getFeaturedSongs = async (req, res, next) => {
  try {
    // fetch 6 random songs using mongodb's aggregation pipeline
    const songs = await Song.aggregate([
      {
        $sample: { size: 6 },
      },
      {
        $project: {
          _id: 1,
          title: 1,
          artist: 1,
          imageUrl: 1,
          audioUrl: 1,
        },
      },
    ]);

    res.json(songs);
  } catch (error) {
    next(error);
  }
};

export const getMadeForYouSongs = async (req, res, next) => {
  try {
    const userId = req.user?.clerkId;
    const count = parseInt(req.query.count) || 4;
    const maxCount = Math.min(count, 10);

    // Check if we have any songs first
    const totalSongs = await Song.countDocuments();
    if (totalSongs === 0) {
      return res.json([]);
    }

    // If we have very few songs, just return random selection
    if (totalSongs <= maxCount) {
      const fallbackSongs = await Song.find()
        .select("_id title artist imageUrl audioUrl duration")
        .lean();
      return res.json(fallbackSongs);
    }

    const songs = await Song.aggregate([
      {
        // Stage 1: Add album information
        $lookup: {
          from: "albums",
          localField: "albumId",
          foreignField: "_id",
          as: "album",
        },
      },
      {
        // Stage 2: Calculate scores with null checks
        $addFields: {
          albumInfo: { $arrayElemAt: ["$album", 0] },
          albumPopularityScore: {
            $cond: {
              if: {
                $and: [
                  { $isArray: "$album" },
                  { $gt: [{ $size: "$album" }, 0] },
                  { $isArray: { $arrayElemAt: ["$album.songs", 0] } },
                ],
              },
              then: { $size: { $arrayElemAt: ["$album.songs", 0] } },
              else: 1,
            },
          },
        },
      },
      {
        // Stage 3: Create era categories with null safety
        $addFields: {
          releaseYear: {
            $ifNull: ["$albumInfo.releaseYear", new Date().getFullYear()],
          },
          eraCategory: {
            $let: {
              vars: { year: { $ifNull: ["$albumInfo.releaseYear", 2020] } },
              in: {
                $switch: {
                  branches: [
                    { case: { $gte: ["$$year", 2020] }, then: "recent" },
                    { case: { $gte: ["$$year", 2010] }, then: "modern" },
                    { case: { $gte: ["$$year", 2000] }, then: "classic" },
                  ],
                  default: "vintage",
                },
              },
            },
          },
          artistLength: { $strLenCP: { $ifNull: ["$artist", ""] } },
        },
      },
      {
        // Stage 4: Calculate recommendation score
        $addFields: {
          recommendationScore: {
            $add: [
              // Era bonus
              {
                $switch: {
                  branches: [
                    { case: { $eq: ["$eraCategory", "recent"] }, then: 3 },
                    { case: { $eq: ["$eraCategory", "modern"] }, then: 2 },
                    { case: { $eq: ["$eraCategory", "classic"] }, then: 1.5 },
                  ],
                  default: 1,
                },
              },
              // Album popularity (normalized)
              { $multiply: [{ $min: ["$albumPopularityScore", 10] }, 0.3] },
              // Duration preference (3-5 minutes)
              {
                $cond: {
                  if: {
                    $and: [
                      { $gte: [{ $ifNull: ["$duration", 0] }, 180] },
                      { $lte: [{ $ifNull: ["$duration", 0] }, 300] },
                    ],
                  },
                  then: 2,
                  else: {
                    $cond: {
                      if: {
                        $and: [
                          { $gte: [{ $ifNull: ["$duration", 0] }, 120] },
                          { $lte: [{ $ifNull: ["$duration", 0] }, 420] },
                        ],
                      },
                      then: 1,
                      else: 0,
                    },
                  },
                },
              },
              // Artist name diversity
              { $multiply: [{ $min: ["$artistLength", 50] }, 0.02] },
              // Random factor for discovery
              { $multiply: [{ $rand: {} }, 3] },
            ],
          },
        },
      },
      {
        // Stage 5: Group by artist to ensure diversity
        $group: {
          _id: "$artist",
          songs: { $push: "$$ROOT" },
          maxScore: { $max: "$recommendationScore" },
          songCount: { $sum: 1 },
        },
      },
      {
        // Stage 6: Select best song from each artist
        $addFields: {
          selectedSong: {
            $arrayElemAt: [
              {
                $filter: {
                  input: "$songs",
                  cond: { $eq: ["$$this.recommendationScore", "$maxScore"] },
                },
              },
              0,
            ],
          },
        },
      },
      {
        // Stage 7: Replace root with selected song
        $replaceRoot: { newRoot: "$selectedSong" },
      },
      {
        // Stage 8: Sort by score
        $sort: { recommendationScore: -1 },
      },
      {
        // Stage 9: Mix top picks with some randomness
        $facet: {
          topPicks: [
            { $limit: Math.ceil(maxCount * 0.7) }, // 70% top picks
            {
              $project: {
                _id: 1,
                title: 1,
                artist: 1,
                imageUrl: 1,
                audioUrl: 1,
                duration: 1,
              },
            },
          ],
          randomPicks: [
            { $sample: { size: Math.floor(maxCount * 0.3) } }, // 30% random
            {
              $project: {
                _id: 1,
                title: 1,
                artist: 1,
                imageUrl: 1,
                audioUrl: 1,
                duration: 1,
              },
            },
          ],
        },
      },
      {
        // Stage 10: Combine results
        $project: {
          allSongs: { $concatArrays: ["$topPicks", "$randomPicks"] },
        },
      },
      {
        $unwind: "$allSongs",
      },
      {
        $replaceRoot: { newRoot: "$allSongs" },
      },
      {
        $sample: { size: maxCount }, // Final shuffle
      },
    ]);

    // Fallback if aggregation fails or returns empty
    if (!songs || songs.length === 0) {
      const fallbackSongs = await Song.aggregate([
        { $sample: { size: maxCount } },
        {
          $project: {
            _id: 1,
            title: 1,
            artist: 1,
            imageUrl: 1,
            audioUrl: 1,
            duration: 1,
          },
        },
      ]);
      return res.json(fallbackSongs);
    }

    res.json(songs);
  } catch (error) {
    console.error("Error fetching made for you songs:", error);
    // Fallback to random songs if recommendation fails
    try {
      const fallbackSongs = await Song.aggregate([
        { $sample: { size: Math.min(count || 4, 10) } },
        {
          $project: {
            _id: 1,
            title: 1,
            artist: 1,
            imageUrl: 1,
            audioUrl: 1,
            duration: 1,
          },
        },
      ]);
      res.json(fallbackSongs);
    } catch (fallbackError) {
      console.error("Fallback also failed:", fallbackError);
      next(error);
    }
  }
};

export const getTrendingSongs = async (req, res, next) => {
  try {
    const songs = await Song.aggregate([
      {
        $sample: { size: 4 },
      },
      {
        $project: {
          _id: 1,
          title: 1,
          artist: 1,
          imageUrl: 1,
          audioUrl: 1,
        },
      },
    ]);
    res.json(songs);
  } catch (error) {
    next(error);
  }
};
