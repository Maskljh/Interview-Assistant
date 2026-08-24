package behavior

// Payload is the client-submitted aggregate of behavior signals.
type Payload struct {
	EmotionDistribution map[string]int `json:"emotion_distribution"`
	NodCount            int            `json:"nod_count"`
	StressLevel         int            `json:"stress_level"`
	StressSegments      []Segment      `json:"stress_segments"`
	FaceDetectedFrames  int            `json:"face_detected_frames"`
	DurationMs          int            `json:"duration_ms"`
}

type Segment struct {
	TMs int `json:"t_ms"`
	V   int `json:"v"`
}

// Result is the read model; Available=false when no record exists.
type Result struct {
	Available           bool           `json:"available"`
	EmotionDistribution map[string]int `json:"emotion_distribution,omitempty"`
	NodCount            int            `json:"nod_count,omitempty"`
	StressLevel         int            `json:"stress_level,omitempty"`
	StressSegments      []Segment      `json:"stress_segments,omitempty"`
	FaceDetectedFrames  int            `json:"face_detected_frames,omitempty"`
	DurationMs          int            `json:"duration_ms,omitempty"`
}
